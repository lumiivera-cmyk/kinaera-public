/**
 * The kinwriter's turn: the single place where your kinwriter writes something.
 *
 * The design doc's core rule is that *a kinwriter turn never requires a user
 * message*. There is one "kinwriter takes a turn" function, and anything can
 * call it:
 *
 *   - you sending a message
 *   - you pressing "Kinwriter's turn"
 *   - you asking for a regeneration
 *   - you commenting on their post (they reply in the thread)
 *   - an event like opening the app (src/wakeups.ts)
 *   - a timer, the "heartbeat" (src/heartbeat.ts)
 *   - another turn they asked for (take_another_turn, a script queue)
 *
 * The turn itself only ever looks at what's already saved: it reads the
 * channel, builds the prompt stack, asks the model, and saves the reply. It
 * never receives your message as an argument. That's what keeps proactive
 * turns an add-on instead of a rewrite later.
 *
 * ## Tools
 *
 * If the turn's connection profile can use tools, the model is offered them
 * (src/tools.ts), and a turn becomes a small loop:
 *
 *   1. Ask the model. It replies with text, tool calls, or both.
 *   2. If it called tools, run each one (as your kinwriter, with every
 *      permission applied), log it, and send the results back.
 *   3. Repeat, up to `MAX_ROUNDS` times, until it replies without calling
 *      anything. Its text is the post.
 *
 * Tool calls written out in the reply's text instead of the API's field
 * (some models do this) are found and run too (src/toolcalls.ts). Every
 * call, and every mistake, goes into the tool log, which the app shows.
 *
 * Actions take effect as they happen. If a turn is stopped or fails after
 * a tool ran, the action stays done; the log shows it.
 */

import { ago } from "./ago.ts";
import { CancelledError, createChatCompletion, type ApiOptions, type ToolSpec } from "./nanogpt.ts";
import type { Decider } from "./jev.ts";
import { replyToMessages } from "./posts.ts";
import { parseExtraParams } from "./profiles.ts";
import { buildCheckPrompt, buildPromptStack, isNothing, whoWrote, type PromptMemory, type PromptReview, type PromptThread, type WakeContext } from "./prompt.ts";
import { channelSummaryText, splitScenes, windowStart, type SeqMessage } from "./summaries.ts";
import { splitTexts } from "./texting.ts";
import { VERBATIM_SLOTS } from "./verbatim.ts";
import { localTime } from "./schedule.ts";
import { voiceAnchors } from "./continuity.ts";
import { describeGrants } from "./standing.ts";
import { wording } from "./wording.ts";
import type { Store } from "./store.ts";
import { extractTextToolCalls, parseArguments, type ParsedCall } from "./toolcalls.ts";
import { bookmarks } from "./bookmarks.ts";
import { isPrivateTool, runScriptSteps, runTool, toolSpecs, type ToolContext, type ToolOutcome } from "./tools.ts";
import { toolMap } from "./toolmap.ts";
import { findScript, INTRODUCED, needsIntroduction, noSuchScript, queueReady, reportSummary, runNextQueued, ScriptError, scriptsOn, type ScriptReport } from "./scripts.ts";
import {
  fromOrientation,
  NEW_PROFILE,
  noteOnUser,
  orientationChannels,
  orientationGuide,
  orientationRunning,
  orientationState,
  proactivityPreference,
} from "./orientation.ts";
import { isSame, KEEP_DRAFT, keepDraftSpec, reflexNudge, reflexReminders, settleReflexes } from "./reflexes.ts";
import type { GroupDirectory, Peer } from "./config.ts";
import { isShared } from "./store.ts";
import { selfNotices } from "./handoff.ts";
import { selfShared, SHARED_NOTICE, waitingRequest } from "./selfnotes.ts";
import { getPad, hasScratchpads, PADS_INTRODUCED } from "./scratchpads.ts";
import type { ApiMessage, ApiToolCall, Channel, ChatMessage, CommentThread, Message, Profile, ReasoningRecord, ToolCallRecord } from "./types.ts";

/** The most rounds of tool calls in one turn. The last round is offered no tools, so it has to write. */
export const MAX_ROUNDS = 6;

/**
 * Rounds for a turn of their own (orientation, the look back): trying
 * several tools one after another takes more, and it messages no one.
 */
const OWN_TIME_ROUNDS = 16;

/**
 * What caused a turn. Used for the server log. "wake" is a turn on their
 * own (see src/wakeups.ts).
 */
export type TurnTrigger = "user-message" | "continue" | "regenerate" | "comment" | "wake" | "group";

/** Extra options for a turn. */
export interface TurnOptions {
  /**
   * Ids of existing kinwriter messages this turn replaces (a regeneration:
   * one literary post, or every bubble of a casual reply). They're left out
   * of the prompt, as if never written, and only once the new reply has
   * been saved do they leave the chat, kept as alternates of it (see
   * `Store.supersede`). If generation fails, or writes nothing, they stay.
   */
  replacing?: string[];
  /**
   * Write with this connection profile instead of picking one from the
   * channel's assignment ("Regenerate with...").
   */
  profileId?: string;
  /** A wake-up: why your kinwriter is taking a turn on their own. */
  wake?: WakeContext;
  /** A turn in a group channel's round (src/groups.ts): doing nothing is the default. */
  group?: boolean;
  /**
   * Another turn they asked for (take_another_turn, or a script queue):
   * their note, and how many such turns in a row this is (see CHAIN_LIMIT).
   */
  again?: { note: string; chain: number };
}

/**
 * The most turns in a row they can take by asking for another
 * (take_another_turn, a script queue) before one has to come from you.
 */
const CHAIN_LIMIT = 30;

/** Everything one turn produced. */
export interface TurnResult {
  /** The new message(s): one post, several casual bubbles, or none. */
  messages: Message[];
  /** Every tool call made during the turn, in order. */
  toolCalls: ToolCallRecord[];
  /** A thinking model's reasoning, round by round (empty for most models). */
  reasoning: ReasoningRecord[];
  /** The messages that were replaced (a regeneration that wrote something). */
  replaced: string[];
  /** Your kinwriter chose not to write (do_nothing, or nothing to say after acting). */
  skipped: boolean;
  /** For a reply to a comment: the thread, with the reply in it. */
  thread?: CommentThread;
}

/** What a dry run shows (see `Kinwriter.dryRun`). */
export interface DryRunResult {
  channel: { id: string; name: string; kind: string };
  profile: { id: string; name: string; model: string; supportsTools: boolean };
  /** The prompt stack, as "Preview prompt" shows it (private things replaced). */
  messages: ChatMessage[];
  /** The tools offered, with what the model is told about each. */
  tools: { name: string; description: string; private: boolean }[];
  /** With `send`: what the model wrote, and the tools it called (not run). */
  reply?: { content: string; toolCalls: { name: string; arguments: string }[]; reasoning: string };
}

/** Thrown when a turn is requested in a channel where one is still being written. */
export class BusyError extends Error {
  constructor() {
    super("Your kinwriter is already writing in this channel. Wait for that reply first.");
    this.name = "BusyError";
  }
}

/**
 * The connection profile for one turn in a channel: the channel's own
 * assignment if it has one, otherwise the one in Settings for its kind.
 * A roulette picks at random each time (pass `random` to choose).
 *
 * OOC chat is an agentic job, so its roulettes prefer tool-capable profiles.
 */
export function pickProfile(store: Store, channel: Channel, random?: number, job: "turn" | "summary" = "turn"): Profile {
  const settings = store.getSettings();
  // Summaries have their own assignment, or use roleplay's.
  if (job === "summary") return store.profiles.pick(settings.summaryAssignment || settings.rpAssignment, false, random);
  // The practice channel is written like OOC: as themselves, with tools.
  const assignment = channel.assignment ?? (channel.kind === "rp" ? settings.rpAssignment : settings.oocAssignment);
  return store.profiles.pick(assignment, channel.kind !== "rp", random);
}

/** Options for building a channel's prompt. */
export interface PromptOptions {
  /** Messages to leave out (the ones being regenerated). */
  excludeIds?: string[];
  /** The profile writing: its model notes, and whether tools are offered. */
  profile?: Profile;
  /** A comment thread your kinwriter is replying to. */
  replyingTo?: string;
  /** A wake-up. */
  wake?: WakeContext;
  /** For the heartbeat's check: its short prompt instead of a turn's (see `buildCheckPrompt`). */
  checkOnly?: boolean;
  /** For the heartbeat's check: the tools the turn would have, with their own note on each. */
  checkTools?: { name: string; note: string | null }[];
  /**
   * For the app's "Preview prompt": the journal is private, so its entries
   * are replaced with a line saying so (the prompt itself still has them).
   */
  preview?: boolean;
  /**
   * With `preview`: keep their self-notes in, though they're private. Only
   * for counting sizes they read themselves (read_prompt_manifest), never
   * for anything the app shows.
   */
  keepSelfNotes?: boolean;
  /** The other kinwriters on their server (names only), for "Kinwriters here". */
  peers?: Peer[];
  /** Group channels and DMs (src/groups.ts), for who's in each. */
  groups?: GroupDirectory | null;
}

/**
 * Build the prompt stack for a channel from what's saved.
 *
 * Used by the turn itself and by the "Preview prompt" button, so the preview
 * is always exactly what a turn would send.
 */
export function promptForChannel(store: Store, channelId: string, options: PromptOptions = {}): ChatMessage[] {
  const excluded = new Set(options.excludeIds ?? []);
  const channel = store.getChannel(channelId);
  const channels = store.listChannels();
  const settings = store.getSettings();
  const messages = store.getMessages(channelId).filter((m) => !excluded.has(m.id));
  const byId = new Map(messages.map((m) => [m.id, m]));

  // Everything from the notebook is as *your kinwriter* may see it: entries
  // hidden from them never reach the prompt.
  const notebook = channel.kind !== "ooc" ? store.notebook.forPrompt(channelId) : undefined;

  // Which messages are sent in full, and the summaries of those before them.
  const { start, memory } = promptWindow(store, channel, messages);
  // Moments kept in full that have scrolled out of the recent messages.
  const kept = new Set(store.verbatim.ids(channelId));
  const verbatim = messages.slice(0, start).filter((m) => kept.has(m.id));

  // Their journal: private. The preview shows only that it's there.
  // Entries written during an orientation carry the "from orientation" mark.
  const forJournal = store.journal.forPrompt();
  const marked = forJournal.entries.map((e) => ({ ...e, fromOrientation: fromOrientation(store, e.createdAt) }));
  const journal = options.preview
    ? {
        entries: marked.map((e) => ({ ...e, content: "(private: the journal isn't shown in the app)" })),
        faded: forJournal.faded,
      }
    : { ...forJournal, entries: marked };
  const identity = store.identity.current();
  const channelName = (id: string | null) => (id ? (channels.find((c) => c.id === id)?.name ?? null) : null);

  // Notes you attached to messages still in the conversation, unless
  // they're already in the prompt as the cast, lore or linked notes.
  const inPrompt = new Set([...(notebook?.pinned ?? []), ...(notebook?.linked ?? [])].map((p) => p.entry.id));
  const window = messages.slice(start);
  const attached = store.notebook
    .forPromptEntries(window.flatMap((m) => m.attachments))
    .filter((p) => !inPrompt.has(p.entry.id));

  // The heartbeat's check decides for the model that writes OOC, which has
  // tools (the rules make sure), so it sees what that model would.
  const tools = options.checkOnly || (options.profile?.supportsTools ?? false);
  const replying = options.replyingTo ? store.comments.thread(options.replyingTo) : undefined;

  return (options.checkOnly ? buildCheckPrompt : buildPromptStack)({
    settings,
    channel,
    channels,
    messages,
    windowStart: start,
    memory,
    digests: channel.kind === "ooc" && settings.summaries ? digestsFor(store, channels) : undefined,
    mentioned:
      // Channels named or #tagged in OOC (and in #practice, where orientation's linking lesson is).
      channel.kind === "ooc" || channel.kind === "practice" ? mentionedChannels(store, channel, channels, window) : undefined,
    notebook,
    // In a story channel: everything else in the notebook, by name only, so they
    // look an entry up (or add to it) instead of making it again.
    notebookIndex:
      channel.kind === "rp" && tools
        ? (() => {
            const here = new Set([...(notebook?.pinned ?? []), ...(notebook?.linked ?? [])].map((p) => p.entry.id));
            return store.notebook.kinwriterOverview().filter((p) => !here.has(p.entry.id));
          })()
        : undefined,
    overview:
      channel.kind === "ooc"
        ? {
            castNames: Object.fromEntries(channels.map((c) => [c.id, kinwriterCharacterNames(store, c.id)])),
            entries: store.notebook.kinwriterOverview(),
          }
        : undefined,
    modelNotes: options.profile?.quirkPrompt,
    attached,
    threads: openThreads(store, channelId, byId, replying?.id),
    reviews: tools ? reviewsFor(store) : [],
    recentActions: recentActions(store, channelId),
    inbox: inboxFor(store).lines,
    tools,
    replyingTo: replying
      ? {
          threadId: replying.id,
          quote: replying.quote,
          note: replying.comments.at(-1)?.note ?? "",
          onYourMessage: byId.get(replying.messageId)?.author === "kinwriter",
        }
      : undefined,
    wake: options.wake,
    checkTools: options.checkTools,
    library: (() => {
      const marks = bookmarks(store);
      return store.library.forChannel(channel).map((d) => ({ ...d, readTo: marks[d.id]?.to }));
    })(),
    customEmojis: store.reactions.listEmojis().map((e) => e.name),
    categoryNames: Object.fromEntries(store.listCategories().map((c) => [c.id, c.name])),
    // Their self-notes are private unless they share them (src/selfnotes.ts): the preview shows that they're there.
    identity: identity
      ? options.preview && !options.keepSelfNotes && !selfShared(store)
        ? { identity: "(private: their self-notes aren't shown unless they share them)", tastes: identity.tastes.trim() ? "(private)" : "" }
        : { identity: identity.identity, tastes: identity.tastes }
      : undefined,
    selfPage: store.selfPage.view().standing,
    journal,
    verbatim,
    editMarkers: store.selfPage.editMarkers(),
    notices: noticesFor(store, tools, channel),
    schedule: {
      now: localTime(new Date()),
      status: (() => {
        const value = store.appState.get("status");
        return value ? (JSON.parse(value) as { text: string }).text : null;
      })(),
      waiting: store.schedule.waiting().map((w) => ({ id: w.id, at: w.at, note: w.note, channel: channelName(w.channelId) })),
    },
    // Never the messages already here, nor ones this turn replaces (a regeneration).
    permissions: describeGrants(store),
    // Group channels and DMs: who's in this one, and in each (src/groups.ts).
    group: isShared(channel) ? (options.groups?.info(channel.id) ?? null) : null,
    shared: Object.fromEntries(channels.filter(isShared).map((c) => [c.id, options.groups?.info(c.id) ?? null])),
    // Who else is on their server, with their private note on each (src/relationships.ts).
    kinwritersHere: (options.peers ?? []).map((p) => ({
      name: p.name,
      note: options.preview ? (store.relationships.all().has(p.id) ? "(private)" : null) : (store.relationships.all().get(p.id)?.note ?? null),
    })),
    anchors: voiceAnchors(store, channel, new Set([...window.map((m) => m.id), ...excluded])),
    // In an orientation running here, every turn carries its guide (an
    // orientation's own first turns carry it as "Why you're up" instead).
    orientation: (() => {
      const session = orientationRunning(store);
      if (!session || !orientationChannels(session).includes(channel.id) || options.wake) return null;
      const names = tools ? toolSpecs({ store, channel, mode: "post" }).map((t) => t.function.name) : [];
      return orientationGuide(names, session, false, store);
    })(),
    profileNote: profileNoteFor(store, options.profile),
    // You and them: their private note on you, and how proactive they'd like to be.
    you: tools
      ? {
          note: options.preview ? (noteOnUser(store) ? "(private)" : null) : noteOnUser(store),
          preference: proactivityPreference(store)?.level ?? null,
          chattiness: store.getSettings().wakeups,
        }
      : undefined,
    // Private, like the journal: the preview shows that they're there, not what they're called.
    drafts: store.drafts.all().map((d) => ({
      id: d.id,
      title: options.preview ? "(private)" : d.title,
      channel: channelName(d.channelId),
      updatedAt: d.updatedAt,
    })),
    // A story channel's scratchpads: the shared one, and theirs (private: the
    // preview shows that it's there). Never yours (src/scratchpads.ts).
    scratchpad: hasScratchpads(channel)
      ? (() => {
          const shared = getPad(store, channel.id, "shared");
          const own = getPad(store, channel.id, "kinwriter");
          return {
            shared: { text: shared.text, by: shared.by, at: shared.at },
            private: { text: options.preview && own.text ? "(private)" : own.text, by: own.by, at: own.at },
          };
        })()
      : undefined,
  });
}

/**
 * Which of a channel's messages are sent in full (from `start`), and the
 * summaries of those before them (`memory`). The practice channel is never
 * summarized.
 */
function promptWindow(store: Store, channel: Channel, messages: Message[]): { start: number; memory: PromptMemory | undefined } {
  const settings = store.getSettings();
  const summarized = settings.summaries && channel.kind !== "practice";
  const seqMessages = store.summaries.withSeq(channel.id, messages);
  const current = store.summaries.all(channel.id).find((s) => s.kind === "current") ?? null;
  const start = windowStart(seqMessages, channel.kind, {
    historyLimit: settings.historyLimit,
    summaryEvery: settings.summaryEvery,
    enabled: summarized,
    current,
  });
  return { start, memory: summarized ? memoryFor(store, channel, seqMessages, start) : undefined };
}

/** Their note on the profile writing this turn, if they wrote one. */
function profileNoteFor(store: Store, profile: Profile | undefined): { profile: string; note: string } | undefined {
  if (!profile) return undefined;
  const note = store.continuity.profileNotes().get(profile.id);
  return note ? { profile: profile.name, note: note.note } : undefined;
}

/**
 * Things your kinwriter should know this turn: their orientation request
 * waiting for you, a DM waiting, a new profile (once).
 */
function noticesFor(store: Store, tools = true, channel?: Pick<Channel, "kind">): string[] {
  const notices: string[] = [];
  const words = wording("orientation");
  // Scratchpads are new: told once, on a turn that could use them (src/scratchpads.ts).
  if (tools && !store.appState.get(PADS_INTRODUCED)) notices.push(wording("scratchpad").introduction ?? "");
  const request = orientationState(store).request;
  if (request) notices.push((words.requested ?? "").replace("{note}", request.note ? ` ("${request.note}")` : ""));
  // A kinwriter wrote to them in a DM, and they haven't answered yet.
  if (tools) {
    for (const dm of store.listChannels().filter((c) => c.kind === "dm")) {
      const last = store.lastMessage(dm.id);
      if (last?.author === "peer") {
        notices.push((wording("kinwriters")["dm-waiting"] ?? "").replace("{name}", last.speaker?.name ?? "A kinwriter").replace("{channel}", dm.name));
      }
    }
  }
  const names = store.appState.get(NEW_PROFILE);
  if (names) notices.push((words["new-profile"] ?? "A new profile joined your roulette: {names}.").replace("{names}", names));
  if (tools) notices.push(...selfNotices(store, { ooc: channel?.kind === "ooc", orienting: orientationRunning(store) !== null }));
  // Scripts were just turned on for them: what changes, once (src/scripts.ts).
  if (tools && needsIntroduction(store)) notices.push(wording("scripts").introduction ?? "");
  return notices;
}

/** How many finished scenes' summaries are sent in full (besides the story so far). */
const RECENT_SCENES = 2;

/**
 * The prompt's summaries for a channel whose prompt starts at `start`: only
 * what covers messages that aren't sent in full.
 *
 * - The story so far, if anything before the recent messages is missing.
 * - The last `RECENT_SCENES` finished scenes that aren't all in the
 *   recent messages.
 * - What happened earlier in the current scene (or OOC conversation), if
 *   its oldest messages were folded into a summary.
 */
function memoryFor(store: Store, channel: Channel, messages: SeqMessage[], start: number): PromptMemory {
  if (start === 0) return {};
  const scenes = splitScenes(messages, channel.kind);
  const firstSent = messages[start]?.seq ?? Infinity;
  const memory: PromptMemory = {};

  const story = store.summaries.get(channel.id, "story");
  if (story?.content) memory.story = story.content;

  memory.scenes = scenes
    .map((scene, index) => ({ scene, index }))
    // Finished scenes with at least some of their messages not sent in full.
    .filter(({ scene }) => scene.end && (scene.posts[0]?.seq ?? Infinity) < firstSent)
    .map(({ scene, index }) => ({ index, title: scene.start?.content, summary: store.summaries.get(channel.id, "scene", scene.end!.id) }))
    .filter((s) => s.summary?.content)
    .slice(-RECENT_SCENES)
    .map((s) => ({ heading: `Scene ${s.index + 1}${s.title ? `, "${s.title}"` : ""}`, summary: s.summary!.content }));

  const scene = scenes.at(-1)!;
  const current = store.summaries.get(channel.id, "current", scene.start?.id ?? "");
  if (current?.content && !current.stale && current.throughSeq < firstSent) memory.earlier = current.content;
  return memory;
}

/** Every channel's digest, by channel id (for OOC's overview). */
function digestsFor(store: Store, channels: Channel[]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const channel of channels) {
    const digest = store.summaries.get(channel.id, "digest");
    if (digest?.content) digests[channel.id] = digest.content;
  }
  return digests;
}

/** How many of the newest OOC messages are checked for channels that come up. */
const MENTION_WINDOW = 6;

/**
 * Channels that came up in the last few OOC messages (by `#name`, or by
 * name as a word), with their fuller summary: the story so far, the last
 * scene, and what's happened in the scene still going. At most two.
 *
 * A bare word ("story") may not be about the channel at all: the summary is
 * simply included, and your kinwriter can tell for themselves whether it's
 * relevant.
 */
function mentionedChannels(store: Store, ooc: Channel, channels: Channel[], window: Message[]): { name: string; summary: string }[] {
  const found: { name: string; summary: string }[] = [];
  for (const { channel, explicit } of mentionCandidates(ooc, channels, window)) {
    if (found.length >= 2) break;
    // (Its digest is already in the list of channels.)
    const summary = store.getSettings().summaries ? channelSummaryText(store, channel, { withDigest: false }) : "";
    if (summary) found.push({ name: channel.name, summary });
    // A #tag on a channel with no summary yet (a new scene): its newest posts.
    else if (explicit) {
      const posts = store.getMessages(channel.id).filter((m) => m.kind === "post").slice(-3);
      if (posts.length) {
        found.push({ name: channel.name, summary: `No summary yet. Its newest posts:\n${posts.map((m) => `${whoWrote(m, true)}: ${m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content}`).join("\n\n")}` });
      }
    }
  }
  return found;
}

/**
 * The channels named in an OOC channel's last few posts: as `#story`
 * (`explicit`), or, for a storyline, as the bare word "story" (not explicit).
 */
export function mentionCandidates(ooc: Channel, channels: Channel[], window: Message[]): { channel: Channel; explicit: boolean }[] {
  const text = window
    .filter((m) => m.kind === "post")
    .slice(-MENTION_WINDOW)
    .map((m) => m.content.toLowerCase())
    .join("\n");
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: { channel: Channel; explicit: boolean }[] = [];
  for (const channel of channels) {
    if (channel.id === ooc.id || channel.kind === "practice") continue;
    const name = channel.name.toLowerCase();
    if (text.includes(`#${name}`)) found.push({ channel, explicit: true });
    // A bare word only brings in a storyline: another OOC chat comes in only when #tagged,
    // so "ooc" said in #off-topic doesn't pull #ooc's talk in.
    else if (channel.kind === "rp" && name.length >= 3 && new RegExp(`(^|[^\\w])${escape(name)}($|[^\\w])`).test(text)) found.push({ channel, explicit: false });
  }
  return found;
}

/** Unresolved threads on this channel's messages, newest ten, plus the one being replied to. */
function openThreads(store: Store, channelId: string, byId: Map<string, Message>, replyingTo?: string): PromptThread[] {
  return store.comments
    .forChannel(channelId)
    .filter((t) => (!t.resolved || t.id === replyingTo) && byId.has(t.messageId))
    .slice(-10)
    .map((t) => ({
      id: t.id,
      quote: t.quote,
      onYourMessage: byId.get(t.messageId)!.author === "kinwriter",
      comments: t.comments.map((c) => ({ author: c.author, note: c.note })),
    }));
}

/** Suggestions waiting for your kinwriter, described: notebook changes, their identity, notes for their self-page. */
export function reviewsFor(store: Store): PromptReview[] {
  const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim().slice(0, 1500)}"`;
  const identity: PromptReview[] = store.identity.pending().map((v) => {
    const now = store.identity.current();
    const parts: string[] = [];
    if (v.identity !== now?.identity) parts.push(`change who you are to ${quote(v.identity)}`);
    if (v.tastes !== now?.tastes) parts.push(`change your tastes to ${quote(v.tastes)}`);
    if (v.note) parts.push(`their note: ${quote(v.note)}`);
    return { id: `i${v.id}`, entry: "your identity", description: parts.join("; ") || "a change", tool: "review_identity_suggestion" };
  });
  const notes: PromptReview[] = store.selfPage.pendingNotes().map((n) => ({
    id: n.id,
    entry: "your self-page",
    description: `a note on what your writing shows: ${quote(n.text)}`,
    tool: "review_self_note",
  }));
  // Rewrites you suggested for parts of their messages (src/rewrites.ts).
  const rewrites: PromptReview[] = store.rewrites.pending().flatMap((r) => {
    const message = safeMessage(store, r.messageId);
    if (!message) return [];
    const where = store.hasChannel(message.channelId) ? `#${store.getChannel(message.channelId).name}` : "a channel";
    return [{ id: r.id, entry: `your message in ${where}`, description: `replace ${quote(r.quote)} with ${quote(r.replacement)}`, tool: "review_rewrite" }];
  });
  // The user asking to read their self-notes (src/selfnotes.ts): theirs to decide.
  const share: PromptReview[] = waitingRequest(store)
    ? [{ id: "self-notes", entry: "your self-notes", description: wording("seeds")["share-request"] ?? "the user asks to read your self-notes", tool: "share_self_notes" }]
    : [];
  return [...share, ...identity, ...notes, ...notebookReviews(store), ...rewrites];
}

/** A message, or null if it's gone. */
function safeMessage(store: Store, id: string): Message | null {
  try {
    return store.getMessage(id);
  } catch {
    return null;
  }
}

/** Notebook suggestions waiting for your kinwriter, described. */
function notebookReviews(store: Store): PromptReview[] {
  return store.notebook.waitingFor("kinwriter").flatMap((suggestion) => {
    const entry = store.notebook.listEntries("kinwriter", true).find((e) => e.id === suggestion.entryId);
    if (!entry) return [];
    const change = suggestion.change;
    const parts: string[] = [];
    if (change.delete) parts.push("delete it");
    if (change.name !== undefined) parts.push(`rename it to "${change.name}"`);
    if (change.fields !== undefined) {
      const before = new Map(entry.fields.map((f) => [f.label, f.value]));
      const after = new Map(change.fields.map((f) => [f.label, f.value]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((l) => before.get(l) !== after.get(l));
      parts.push(
        ...changed.map((label) =>
          after.has(label) ? `set ${label} to "${after.get(label)}"` : `remove ${label}`,
        ),
      );
    }
    if (change.systemPrompt !== undefined) parts.push(`change its notes to "${change.systemPrompt}"`);
    return [{ id: suggestion.id, entry: entry.name, description: parts.join("; ") || "a change" }];
  });
}

/** Tool actions that changed something (not reading), newest last. */
function recentActions(store: Store, channelId: string): string[] {
  const quiet = new Set(["read_notebook_entry", "search_notebook", "do_nothing", "read_message_history", "read_interventions", "check"]);
  return store.toolLog
    .forChannel(channelId, 60)
    .filter((call) => call.status === "ok" && !quiet.has(call.name))
    .slice(-8)
    .map((call) => `${call.summary} (${ago(call.createdAt)})`);
}

/** Outcomes stay in the prompt this long after they happen (and always until they've been in one turn). */
const INBOX_MEMORY_MS = 24 * 3_600_000;

/**
 * The inbox as your kinwriter sees it (src/inbox.ts): what they're waiting
 * on, and what came of it (your answers, how proposals went). An outcome is
 * carried until it has been in one of their turns, and for a day after it
 * happened. `deliver` is the outcomes to mark as delivered once this turn
 * is done.
 */
export function inboxFor(store: Store, now = Date.now()): { lines: string[]; deliver: string[] } {
  const quote = (text: string) => `"${text.replace(/\s+/g, " ").trim()}"`;
  const lines: string[] = [];
  const deliver: string[] = [];
  const items = store.inbox.recent(100).reverse();
  for (const item of items) {
    const fresh = item.status !== "open" && (item.deliveredAt === null || now - new Date(item.resolvedAt ?? item.createdAt).getTime() < INBOX_MEMORY_MS);
    if (item.status !== "open" && !fresh) continue;
    if (item.status !== "open" && item.deliveredAt === null) deliver.push(item.id);
    const isNew = item.status !== "open" && item.deliveredAt === null ? "New: " : "";
    if (item.kind === "ask") {
      const asked = `You asked the user (${item.askKind}): ${quote(item.text)}.`;
      if (item.status === "open") lines.push(`${asked} No answer yet.`);
      else if (item.status === "answered") lines.push(`${isNew}${asked} They answered: ${quote(item.answer ?? "")}`);
      else lines.push(`${isNew}${asked} They set it aside without answering.`);
    } else if (item.kind === "rename") {
      if (item.status === "open") lines.push(`You asked to be called ${item.targetName}; the user hasn't decided yet.`);
      else if (item.status === "approved") lines.push(`${isNew}The user approved your new name: you're ${item.targetName} now.`);
      else lines.push(`${isNew}The user declined your request to be called ${item.targetName}.`);
    } else if (item.status === "open") {
      lines.push(`You proposed deleting #${item.targetName}; the user hasn't decided yet.`);
    } else {
      lines.push(`${isNew}The user ${item.status === "approved" ? "approved" : "denied"} your proposal to delete #${item.targetName}.`);
    }
  }
  return { lines, deliver };
}

/**
 * The characters your kinwriter plays in a channel's cast (their own and
 * shared ones they can see), in cast order.
 */
export function kinwriterCharacterNames(store: Store, channelId: string): string[] {
  return store.notebook
    .forPrompt(channelId)
    .pinned.filter((p) => p.entry.kind === "character" && p.entry.owner !== "user")
    .map((p) => p.entry.name);
}

/** The request settings a profile locks in (everything but the messages). */
export function profileRequest(profile: Profile) {
  return {
    model: profile.model,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    topP: profile.topP,
    minP: profile.minP,
    reasoningEffort: profile.reasoningEffort,
    extraParams: parseExtraParams(profile.extraParams),
  };
}

export class Kinwriter {
  /**
   * The channels the kinwriter is writing in right now, each with the
   * controller that can stop that turn (see `cancel`).
   *
   * Only one turn may run per channel at a time. Without this, tapping Send
   * twice would start two generations that both read the same channel and
   * both save a reply, and your kinwriter would answer the same post twice.
   * Different channels don't block each other.
   */
  private readonly writingIn = new Map<string, AbortController>();

  /** Jev, once the server has set it up: for the `check` tool, and for reading drafts for their reflexes. */
  decider: Decider | null = null;

  /** The other kinwriters on their server (names only), from the hub. */
  peers: () => Peer[] = () => [];

  /** Group channels and DMs, from the hub (src/groups.ts). */
  groups: GroupDirectory | null = null;

  /**
   * Told when your kinwriter posts in a story in answer to you (a reply, a
   * Kinwriter's turn, a regeneration), for the moment in OOC after it (the
   * "aside" wake-up, src/wakeups.ts).
   */
  onStoryPosted: ((channel: Channel) => void) | null = null;

  /** Told when your kinwriter posts in another channel mid-turn (`post_in_channel`), for notifications. */
  onPostedElsewhere: ((channel: Channel, messages: Message[]) => void) | null = null;

  constructor(
    private readonly store: Store,
    /** The API it writes with (also used for `consult`). */
    readonly api: ApiOptions,
  ) {}

  /** Whether a turn is in progress in a channel. */
  isBusy(channelId: string): boolean {
    return this.writingIn.has(channelId);
  }

  /** Every channel with a turn in progress. */
  busyChannels(): string[] {
    return [...this.writingIn.keys()];
  }

  /** Channels where a tool call is running right now ("reading"), for presence. */
  private readonly readingIn = new Set<string>();

  /** What they're doing in each busy channel: writing, or reading (a tool call in progress). */
  phases(): Record<string, "writing" | "reading"> {
    return Object.fromEntries(this.busyChannels().map((id) => [id, this.readingIn.has(id) ? "reading" : "writing"]));
  }

  /** Stop every turn running, in every channel (before the kinwriter stops). */
  cancelAll(): void {
    for (const channelId of this.busyChannels()) this.cancel(channelId);
  }

  /**
   * Stop the turn running in a channel, if there is one (the Stop button).
   *
   * The request to the model is abandoned and nothing more is saved, so the
   * channel is left as it was, apart from any tool actions already taken.
   * The channel is free again as soon as this returns.
   *
   * @returns `true` if a turn was stopped, `false` if none was running.
   */
  cancel(channelId: string): boolean {
    const controller = this.writingIn.get(channelId);
    if (!controller) return false;
    controller.abort();
    // Free the channel right away rather than waiting for the aborted
    // request to wind down.
    this.writingIn.delete(channelId);
    console.log(`[kinwriter] turn stopped in channel ${channelId}`);
    return true;
  }

  /**
   * Your kinwriter takes one turn in a channel: reads it, acts if they want
   * to, writes a reply, saves it.
   *
   * @throws NotFoundError  if the channel doesn't exist.
   * @throws BusyError      if a turn is already running in that channel.
   * @throws CancelledError if the turn was stopped with `cancel`.
   * @throws ApiError       if the model couldn't produce a reply.
   *                        In those cases no message is saved.
   */
  takeTurn(channelId: string, trigger: TurnTrigger, options: TurnOptions = {}): Promise<TurnResult> {
    return this.run(channelId, trigger, options);
  }

  /**
   * Your kinwriter replies to a comment thread (after you comment). The reply
   * goes in the thread, never into the channel as a post.
   */
  replyToComment(threadId: string): Promise<TurnResult> {
    const thread = this.store.comments.thread(threadId);
    const channelId = this.store.getMessage(thread.messageId).channelId;
    return this.run(channelId, "comment", {}, threadId);
  }

  /**
   * A dry run (Settings → Prompts → Dry run): everything a turn in this
   * channel would send, built exactly as the turn builds it, without
   * taking one. Nothing is saved, nothing is delivered, and no tool runs.
   *
   * With `send`, the request also goes to the model once, and its reply
   * comes back: the text it would post and the tools it would call (first
   * round only, since calls aren't run). That costs one request.
   *
   * What's shown is the preview version of the prompt: journal entries,
   * draft titles and notes on other kinwriters are replaced with a line
   * saying they're private, as in "Preview prompt", and so are private
   * tools' arguments. `displayWake` is the wake-up with the same done to
   * it (the look back carries journal entries). The model gets the real
   * prompt, as in a real turn.
   */
  async dryRun(
    channelId: string,
    options: { wake?: WakeContext; displayWake?: WakeContext; profileId?: string; send?: boolean } = {},
  ): Promise<DryRunResult> {
    const channel = this.store.getChannel(channelId);
    const profile = options.profileId ? this.store.profiles.get(options.profileId) : pickProfile(this.store, channel);
    const build = (preview: boolean, wake?: WakeContext) =>
      promptForChannel(this.store, channelId, { profile, wake, preview, peers: this.peers(), groups: this.groups });
    const context: ToolContext = {
      store: this.store,
      channel,
      mode: "post",
      api: this.api,
      turn: { consults: 0 },
      wake: options.wake?.reason,
      model: profile.model,
      profileName: profile.name,
      profileId: profile.id,
      peers: this.peers(),
      groups: this.groups ?? undefined,
    };
    const specs = profile.supportsTools ? toolSpecs(context) : [];
    const result: DryRunResult = {
      channel: { id: channel.id, name: channel.name, kind: channel.kind },
      profile: { id: profile.id, name: profile.name, model: profile.model, supportsTools: profile.supportsTools },
      messages: build(true, options.displayWake ?? options.wake),
      tools: specs.map((t) => ({ name: t.function.name, description: t.function.description, private: isPrivateTool(t.function.name) })),
    };
    if (!options.send) return result;

    console.log(`[kinwriter] dry run in #${channel.name} using "${profile.name}" (${profile.model}): nothing is saved`);
    const response = await createChatCompletion(this.api, {
      ...profileRequest(profile),
      messages: build(false, options.wake),
      tools: specs,
    });
    let calls: ParsedCall[] = response.toolCalls.map((c) => ({ ...c, source: "native" as const }));
    let text = response.content;
    if (calls.length === 0 && specs.length > 0) {
      const found = extractTextToolCalls(text);
      calls = found.calls;
      text = found.content;
    }
    result.reply = {
      content: text.trim(),
      toolCalls: calls.map((c) => ({ name: c.name, arguments: isPrivateTool(c.name) ? "(private)" : c.arguments })),
      reasoning: response.reasoning,
    };
    return result;
  }

  /**
   * The heartbeat's check (Settings → Heartbeat check): before the model
   * that writes OOC is asked, a cheaper profile reads a short version of
   * the wake-up prompt (`buildCheckPrompt`) and says whether your kinwriter
   * would use this moment at all. One request, no tools, nothing saved.
   * Anything but a clear yes is a no.
   */
  async heartbeatCheck(channelId: string, wake: WakeContext): Promise<{ yes: boolean; profile: Profile; answer: string }> {
    const profile = this.store.profiles.pick(this.store.getSettings().heartbeatAssignment, false);
    // What the turn could do with the moment: its tools, by name (the
    // check sends none), so a yes isn't only for texting you.
    const channel = this.store.getChannel(channelId);
    const writer = pickProfile(this.store, channel);
    const map = toolMap(this.store);
    const checkTools = toolSpecs({
      store: this.store,
      channel,
      mode: "post",
      decider: this.decider ?? undefined,
      api: this.api,
      wake: wake.reason,
      model: writer.model,
      profileName: writer.name,
      profileId: writer.id,
      peers: this.peers(),
      groups: this.groups ?? undefined,
    })
      // Letting the moment pass is the check's no, not a tool.
      .filter((t) => t.function.name !== "do_nothing")
      .map((t) => ({ name: t.function.name, note: map[t.function.name]?.when ?? null }));
    const conversation: ApiMessage[] = promptForChannel(this.store, channelId, { profile, wake, checkOnly: true, checkTools, peers: this.peers(), groups: this.groups });
    appendToLastUser(conversation, wording("time")["heartbeat-check"] ?? "");
    console.log(`[kinwriter] heartbeat check using "${profile.name}" (${profile.model})`);
    const response = await createChatCompletion(this.api, { ...profileRequest(profile), messages: conversation });
    const answer = response.content.trim();
    return { yes: checkSaysYes(answer), profile, answer };
  }

  private async run(channelId: string, trigger: TurnTrigger, options: TurnOptions, replyingTo?: string): Promise<TurnResult> {
    if (this.writingIn.has(channelId)) throw new BusyError();
    const channel = this.store.getChannel(channelId); // throws if missing

    const controller = new AbortController();
    this.writingIn.set(channelId, controller);
    // Another turn they asked for, to start once this one has let go of the channel.
    let followUp: string | null = null;
    try {
      const profile = options.profileId ? this.store.profiles.get(options.profileId) : pickProfile(this.store, channel);
      // Inbox outcomes this turn's prompt carries: delivered once it's done.
      const delivering = inboxFor(this.store).deliver;
      const newProfiles = this.store.appState.get(NEW_PROFILE);
      const conversation: ApiMessage[] = promptForChannel(this.store, channelId, {
        excludeIds: options.replacing,
        profile,
        replyingTo,
        wake: options.wake,
        peers: this.peers(),
        groups: this.groups,
      });
      const context: ToolContext = {
        store: this.store,
        channel,
        mode: replyingTo ? "comment" : "post",
        decider: this.decider ?? undefined,
        api: this.api,
        turn: { consults: 0 },
        wake: options.wake?.reason,
        model: profile.model,
        profileName: profile.name,
        profileId: profile.id,
        peers: this.peers(),
        groups: this.groups ?? undefined,
        isBusy: (id) => this.isBusy(id),
        onPosted: (where, messages) => this.onPostedElsewhere?.(where, messages),
        signal: controller.signal,
      };
      const tools = profile.supportsTools ? toolSpecs(context) : [];
      const turnId = crypto.randomUUID();
      context.logStep = this.stepLogger(channel, turnId, profile.name);

      // A turn they asked for: the next queued script runs first, and they
      // see what it did; then their note (src/scripts.ts).
      if (options.again && !replyingTo) {
        const queued = await runNextQueued(this.store, channelId, (script, from) => runScriptSteps(context, script, from));
        if (controller.signal.aborted) throw new CancelledError();
        appendToLastUser(conversation, againNudge(options.again.note, queued, tools.length > 0));
      }

      const started = Date.now();
      console.log(
        `[kinwriter] turn started in #${channel.name} (${trigger}) using "${profile.name}" (${profile.model})` +
          (tools.length ? `, ${tools.length} tools` : ""),
      );

      const loop = await this.toolLoop({ conversation, tools, context, profile, turnId, signal: controller.signal });
      // Another turn: they asked for one, or scripts are still queued here.
      if (!replyingTo && scriptsOn(this.store) && (context.turn?.again !== undefined || (options.again && queueReady(this.store, channelId)))) {
        followUp = context.turn?.again ?? "";
      }
      // A reminder this turn: whether they acted on it, for the tool log and the line under their message.
      settleReflexes(this.store, loop.toolCalls, !loop.stopped && loop.content !== "" && !isNothing(loop.content));

      // Belt and braces: if the turn was stopped just as the reply arrived,
      // don't save it.
      if (controller.signal.aborted) throw new CancelledError();
      this.store.inbox.markDelivered(delivering);
      if (profile.supportsTools && !this.store.appState.get(PADS_INTRODUCED)) this.store.appState.set(PADS_INTRODUCED, new Date().toISOString());
      // Told once (unless another joined in the meantime).
      if (newProfiles && this.store.appState.get(NEW_PROFILE) === newProfiles) this.store.appState.set(NEW_PROFILE, null);
      // That their self-notes started shared: told once, on a turn that could act on it.
      if (profile.supportsTools && this.store.appState.get(SHARED_NOTICE)) this.store.appState.set(SHARED_NOTICE, null);
      // Introduced to scripts: once, on a turn that could use them.
      if (profile.supportsTools && needsIntroduction(this.store)) this.store.appState.set(INTRODUCED, new Date().toISOString());
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `[kinwriter] turn finished in ${seconds}s after ${loop.rounds} round(s), ${loop.toolCalls.length} tool call(s)` +
          (loop.content ? "" : ", no text"),
      );

      const result: TurnResult = { messages: [], toolCalls: loop.toolCalls, reasoning: loop.reasoning, replaced: [], skipped: false };
      // "[nothing]": a wake-up or comment reply without tools that had
      // nothing to say.
      if ((options.wake || replyingTo || options.group || options.again) && isNothing(loop.content)) loop.content = "";
      if (loop.stopped || loop.content === "") {
        // Nothing to write: your kinwriter chose not to, or only acted. A
        // regeneration keeps the reply it would have replaced.
        result.skipped = true;
        return result;
      }

      if (replyingTo) {
        // A comment is one note: any texting markers become line breaks.
        result.thread = this.store.comments.reply("kinwriter", replyingTo, splitTexts(loop.content).join("\n") || loop.content);
        return result;
      }

      // Re-read the channel: its cast or mode may have changed while the
      // model was writing (possibly through its own tools).
      const current = this.store.getChannel(channelId);
      const newMessages = replyToMessages(
        current,
        loop.content,
        profile.model,
        kinwriterCharacterNames(this.store, channelId).map((name) => ({ name })),
      ).map((m, i) => ({ ...m, profile: profile.name, ...(i === 0 && context.turn?.replyTo ? { replyTo: context.turn.replyTo } : {}) }));

      // Swap old for new in one transaction: never both, never neither.
      result.messages = this.store.db.transaction(() => {
        this.store.supersede(options.replacing ?? [], turnId);
        return this.store.addTurn(newMessages, turnId);
      })();
      result.replaced = options.replacing ?? [];
      if (current.kind === "rp" && (trigger === "user-message" || trigger === "continue" || trigger === "regenerate")) {
        // After this turn has let go of the channel (it's still holding it here).
        const posted = this.onStoryPosted;
        if (posted) queueMicrotask(() => posted(current));
      }
      return result;
    } finally {
      // Always release the lock, even if generation failed. Otherwise one
      // network error would leave the channel "busy" forever. (Only if it's
      // still *this* turn's lock: after a Stop, a new turn may already have
      // started in the channel.)
      if (this.writingIn.get(channelId) === controller) this.writingIn.delete(channelId);
      if (followUp !== null && !controller.signal.aborted) this.anotherTurn(channelId, followUp, options.again?.chain ?? 0);
    }
  }

  /**
   * Start the turn they asked for (take_another_turn, a script queue),
   * once the one before has let go of the channel. At most CHAIN_LIMIT in
   * a row; a turn you start begins the count again.
   */
  private anotherTurn(channelId: string, note: string, chain: number): void {
    if (chain >= CHAIN_LIMIT) {
      console.log(`[kinwriter] not taking another turn in ${channelId}: ${CHAIN_LIMIT} in a row already`);
      return;
    }
    queueMicrotask(() => {
      this.run(channelId, "continue", { again: { note, chain: chain + 1 } }).catch((error) => {
        if (!(error instanceof CancelledError)) console.warn(`[kinwriter] another turn failed: ${error instanceof Error ? error.message : error}`);
      });
    });
  }

  /**
   * Ask the model, run any tools it calls, send back the results, and
   * repeat until it writes without calling anything (see the top of this
   * file).
   *
   * @returns The text to post (possibly ""), the calls made, and whether
   *          your kinwriter chose to do nothing.
   */
  private async toolLoop(turn: {
    conversation: ApiMessage[];
    tools: ToolSpec[];
    context: ToolContext;
    profile: Profile;
    turnId: string;
    signal: AbortSignal;
  }): Promise<{ content: string; toolCalls: ToolCallRecord[]; reasoning: ReasoningRecord[]; stopped: boolean; rounds: number }> {
    const { conversation, tools, context, profile, turnId, signal } = turn;
    const toolCalls: ToolCallRecord[] = [];
    const reasoning: ReasoningRecord[] = [];
    let content = "";
    // Turns of their own, and every turn in an orientation running now, have room to try things.
    const session = orientationRunning(context.store);
    const orienting = Boolean(session && orientationChannels(session).includes(context.channel.id));
    const maxRounds = context.wake === "orientation" || context.wake === "lookback" || orienting ? OWN_TIME_ROUNDS : MAX_ROUNDS;
    // Their follow-through check (src/reflexes.ts): once a turn, on their draft.
    let reflexed = false;
    let draft = "";
    // The round after a reminder: they must call a tool, or choose keep_my_draft.
    let requireTool = false;
    // What they're answering, for their reflexes: the prompt's last message
    // to them, not tool results or reminders added during the turn.
    const lastUser = [...conversation].reverse().find((m) => m.role === "user");
    const userMessage = typeof lastUser?.content === "string" ? lastUser.content : "";

    for (let round = 0; round < maxRounds; round++) {
      if (signal.aborted) throw new CancelledError();
      // The last round offers no tools, so the model has to write. The tools
      // are still sent, with tool_choice "none": some providers reject a
      // conversation with tool calls in it and no tools.
      const last = round === maxRounds - 1;
      const offered = last ? [] : tools;
      const deciding = requireTool && offered.length > 0;
      requireTool = false;
      const response = await createChatCompletion(this.api, {
        ...profileRequest(profile),
        messages: conversation,
        tools: deciding ? [...offered, keepDraftSpec()] : last ? tools : offered,
        toolChoice: deciding ? "required" : last && tools.length > 0 ? "none" : "auto",
        // After acting, the model may have nothing more to say.
        allowEmpty: round > 0,
        signal,
      });
      if (response.reasoning) {
        reasoning.push(
          this.store.reasoning.add({
            channelId: context.channel.id,
            turnId,
            round,
            text: response.reasoning,
            profile: profile.name,
            model: response.model,
          }),
        );
      }

      // Tool calls from the API, or failing that, written in the text.
      let calls: ParsedCall[] = response.toolCalls.map((c) => ({ ...c, source: "native" as const }));
      let text = response.content;
      if (calls.length === 0 && tools.length > 0) {
        const found = extractTextToolCalls(text);
        calls = found.calls;
        text = found.content;
      }
      if (text.trim() !== "") content = text.trim();
      // "[same]" after a reminder: their draft, as it was.
      if (draft && isSame(content)) content = draft;
      if (calls.length === 0) {
        // A draft, with rounds left: Jev reads it for their reflexes. On a
        // yes, a reminder and one more round; they act, rewrite, or keep it.
        if (!reflexed && tools.length > 0 && round < maxRounds - 2 && content && !isNothing(content) && context.mode === "post") {
          reflexed = true;
          const reminders = await reflexReminders(this.store, context.decider, {
            kind: context.channel.kind,
            userMessage,
            draft: content,
            usedTools: toolCalls.filter((c) => c.status === "ok").map((c) => c.name),
          });
          if (signal.aborted) throw new CancelledError();
          if (reminders.length > 0) {
            draft = content;
            toolCalls.push(
              this.store.toolLog.add({
                channelId: context.channel.id,
                turnId,
                round,
                name: "reflex",
                arguments: JSON.stringify({ checks: reminders.map((r) => r.id) }),
                result: JSON.stringify({ reminded: reminders.map((r) => r.reminder) }),
                status: "ok",
                summary: `was reminded by Jev (${reminders.map((r) => r.id).join(", ")})`,
                source: "native",
                profile: profile.name,
              }),
            );
            console.log(`[reflexes] #${context.channel.name}: reminded (${reminders.map((r) => r.id).join(", ")})`);
            conversation.push({ role: "assistant", content });
            conversation.push({ role: "user", content: reflexNudge(reminders) });
            requireTool = true;
            continue;
          }
        }
        return { content, toolCalls, reasoning, stopped: false, rounds: round + 1 };
      }

      // Record the model's request in the conversation, then each result.
      const native = calls.every((c) => c.source === "native");
      if (native) {
        const apiCalls: ApiToolCall[] = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
        conversation.push({ role: "assistant", content: response.content || null, tool_calls: apiCalls });
      } else {
        conversation.push({ role: "assistant", content: response.content });
      }

      let stopped = false;
      let keepDraft = false;
      const textResults: string[] = [];
      for (const call of calls) {
        // After a reminder: their choice to post the draft as it was, without acting.
        const keeping = deciding && call.name === KEEP_DRAFT && Boolean(draft);
        if (keeping) keepDraft = true;
        const parsed = keeping ? parseArguments(call.arguments) : undefined;
        // Their arguments are only a reason: a garbled one still keeps the draft.
        const reason = parsed?.ok && typeof parsed.value.reason === "string" ? parsed.value.reason : undefined;
        const outcome: ToolOutcome = keeping
          ? { ok: true, result: { kept: true }, summary: reason ? `kept their draft (${reason})` : "kept their draft" }
          : offered.length === 0
            ? failed("You're out of tool rounds for this turn, so this wasn't run. Write your reply now.")
            : await this.runCall(context, call);
        toolCalls.push(
          this.store.toolLog.add({
            channelId: context.channel.id,
            turnId,
            round,
            name: call.name,
            // Private tools (the journal, drafts): the log keeps that they
            // ran, never what was in them (see ToolOutcome.logResult).
            arguments: isPrivateTool(call.name) ? JSON.stringify("(private)") : call.arguments,
            result: JSON.stringify(outcome.logResult ?? (isPrivateTool(call.name) ? "(private)" : outcome.result)),
            status: outcome.ok ? "ok" : "error",
            summary: outcome.summary,
            source: call.source,
            profile: profile.name,
          }),
        );
        console.log(
          `[tools] #${context.channel.name} round ${round + 1} (${call.source}): ${call.name} ${isPrivateTool(call.name) ? "(private)" : call.arguments.slice(0, 200)}` +
            ` -> ${outcome.ok ? "ok" : "error"}: ${outcome.summary}`,
        );
        if (native) conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(outcome.result) });
        else textResults.push(`${call.name}: ${JSON.stringify(outcome.result)}`);
        if (outcome.stop) stopped = true;
      }
      if (!native) conversation.push({ role: "user", content: `(Tool results)\n${textResults.join("\n")}` });

      if (stopped) return { content: "", toolCalls, reasoning, stopped: true, rounds: round + 1 };
      if (keepDraft) return { content: draft, toolCalls, reasoning, stopped: false, rounds: round + 1 };
      // The last round ran nothing; whatever text it had is the reply.
      if (offered.length === 0) return { content, toolCalls, reasoning, stopped: false, rounds: round + 1 };
    }
    return { content, toolCalls, reasoning, stopped: false, rounds: maxRounds };
  }

  /**
   * A tools-only turn: run one of their scripts in a channel, exactly as
   * written, with no model call (src/scripts.ts). Used for a wake-up set to
   * run a script. Holds the channel like a turn, so it never runs over one.
   *
   * @throws BusyError   if a turn is running in that channel.
   * @throws ScriptError if there's no such script.
   */
  async runScriptTurn(channelId: string, name: string, fromStep = 1): Promise<ScriptReport> {
    if (this.writingIn.has(channelId)) throw new BusyError();
    const channel = this.store.getChannel(channelId);
    const script = findScript(this.store, name);
    if (!script) throw new ScriptError(noSuchScript(this.store, name));
    const controller = new AbortController();
    this.writingIn.set(channelId, controller);
    let followUp: string | null = null;
    try {
      const profile = pickProfile(this.store, channel);
      const turnId = crypto.randomUUID();
      const context: ToolContext = {
        store: this.store,
        channel,
        mode: "post",
        decider: this.decider ?? undefined,
        api: this.api,
        turn: { consults: 0 },
        wake: "script",
        model: profile.model,
        profileName: profile.name,
        profileId: profile.id,
        peers: this.peers(),
        groups: this.groups ?? undefined,
        isBusy: (id) => this.isBusy(id),
        onPosted: (where, messages) => this.onPostedElsewhere?.(where, messages),
        logStep: this.stepLogger(channel, turnId, profile.name),
        // Stop (or the app shutting down) ends it between steps.
        signal: controller.signal,
      };
      console.log(`[scripts] running "${script.name}" in #${channel.name} as a tools-only turn`);
      const report = await runScriptSteps(context, script, fromStep);
      console.log(`[scripts] ${reportSummary(report)}`);
      // A script ending in take_another_turn: a real turn follows it.
      if (context.turn?.again !== undefined) followUp = context.turn.again;
      return report;
    } finally {
      if (this.writingIn.get(channelId) === controller) this.writingIn.delete(channelId);
      if (followUp !== null && !controller.signal.aborted) this.anotherTurn(channelId, followUp, 0);
    }
  }

  /** Each step a script runs, in the tool log as a call of its own. */
  private stepLogger(channel: Channel, turnId: string, profileName: string): NonNullable<ToolContext["logStep"]> {
    return (script, step, tool, args, outcome) => {
      this.store.toolLog.add({
        channelId: channel.id,
        turnId,
        round: step - 1,
        name: tool,
        arguments: isPrivateTool(tool) ? JSON.stringify("(private)") : JSON.stringify(args),
        result: JSON.stringify(outcome.logResult ?? (isPrivateTool(tool) ? "(private)" : outcome.result)),
        status: outcome.ok ? "ok" : "error",
        summary: `${outcome.summary} (script "${script}", step ${step})`,
        source: "native",
        profile: profileName,
      });
      console.log(`[scripts] #${channel.name} "${script}" step ${step}: ${tool} -> ${outcome.ok ? "ok" : "error"}: ${outcome.summary}`);
    };
  }

  /** Parse one call's arguments and run it. */
  private async runCall(context: ToolContext, call: ParsedCall): Promise<ToolOutcome> {
    const args = parseArguments(call.arguments);
    if (!args.ok) return failed(`${args.error} Call ${call.name} again with valid JSON arguments.`);
    // Presence: "reading" while a tool runs.
    this.readingIn.add(context.channel.id);
    try {
      return await runTool(context, call.name, args.value);
    } finally {
      this.readingIn.delete(context.channel.id);
    }
  }
}

/** Whether the heartbeat check's answer is a yes: the first YES or NO in it decides, and neither is a no. */
export function checkSaysYes(answer: string): boolean {
  return answer.match(/\b(yes|no)\b/i)?.[1]?.toLowerCase() === "yes";
}

/** Add text to the end of the conversation: to its last message if that's yours (the nudge), or as a new one. */
function appendToLastUser(conversation: ApiMessage[], text: string): void {
  const last = conversation.at(-1);
  if (last?.role === "user" && typeof last.content === "string") last.content = `${last.content}\n\n${text}`;
  else conversation.push({ role: "user", content: text });
}

/** What a turn they asked for opens with: what a queued script did, and their note. */
function againNudge(note: string, queued: Awaited<ReturnType<typeof runNextQueued>>, tools: boolean): string {
  const words = wording("scripts");
  const parts: string[] = [];
  if (queued?.skipped) parts.push((words["queue-skipped"] ?? "").replace("{name}", queued.skipped));
  if (queued?.report) {
    const r = queued.report;
    const steps = r.steps.map((st) => ({ step: st.step, tool: st.tool, ok: st.ok, summary: st.summary, result: st.result }));
    const head = r.ok
      ? (words["queue-ran"] ?? "").replace("{name}", r.script)
      : (words["queue-failed"] ?? "").replace("{name}", r.script).replace("{step}", String(r.failedStep)).replace("{error}", r.error ?? "");
    parts.push(`${head}\n${JSON.stringify(steps)}`);
    parts.push(queued.left > 0 ? (words["queue-left"] ?? "").replace("{count}", String(queued.left)) : r.ok ? (words["queue-done"] ?? "") : "");
  }
  if (note) parts.push((words["again-note"] ?? "").replace("{note}", note));
  parts.push(words[tools ? "again-nudge-tools" : "again-nudge"] ?? "");
  return parts.filter(Boolean).join("\n\n");
}

function failed(message: string): ToolOutcome {
  return { ok: false, result: { error: message }, summary: message };
}

/** The outcome of testing whether a profile's model can call tools. */
export interface ToolTestResult {
  /**
   * `native`: it called the tool through the API, the best case.
   * `text`: it wrote the call out in its reply, which works, but less reliably.
   * `none`: it didn't call the tool at all.
   * `broken`: it called it, but the arguments couldn't be read.
   */
  verdict: "native" | "text" | "none" | "broken";
  /** A sentence explaining the verdict. */
  detail: string;
  /** What the model wrote, if anything. */
  content: string;
  /** The call's arguments, as written. */
  arguments: string | null;
  seconds: number;
}

/**
 * Check whether a profile's model can call tools, with one tiny request:
 * the model is asked to call a `check_in` tool with a given word.
 * Throws `ApiError` if the request itself fails.
 */
export async function testToolCalling(api: ApiOptions, profile: Profile): Promise<ToolTestResult> {
  const spec: ToolSpec = {
    type: "function",
    function: {
      name: "check_in",
      description: "Check in, with a word.",
      parameters: {
        type: "object",
        properties: { word: { type: "string", description: "The word to check in with." } },
        required: ["word"],
      },
    },
  };
  const started = Date.now();
  const response = await createChatCompletion(api, {
    ...profileRequest(profile),
    messages: [
      { role: "system", content: "This is a test of tool calling. Call the check_in tool with the word \"lighthouse\". Write nothing else." },
      { role: "user", content: "Call check_in now, please." },
    ],
    tools: [spec],
    allowEmpty: true,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  const native = response.toolCalls.find((c) => c.name === "check_in");
  const written = native ? undefined : extractTextToolCalls(response.content).calls.find((c) => c.name === "check_in");
  const call = native ?? written;
  if (!call) {
    return {
      verdict: "none",
      detail: "The model didn't call the tool. Turn off \"Can use tools\" for this profile, or try another model.",
      content: response.content,
      arguments: null,
      seconds,
    };
  }
  const args = parseArguments(call.arguments);
  if (!args.ok || typeof args.value.word !== "string") {
    return {
      verdict: "broken",
      detail: `The model called the tool, but its arguments couldn't be read${args.ok ? "" : `: ${args.error}`}`,
      content: response.content,
      arguments: call.arguments,
      seconds,
    };
  }
  return native
    ? {
        verdict: "native",
        detail: "The model called the tool properly, through the API. Tools should work well.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      }
    : {
        verdict: "text",
        detail: "The model wrote the tool call into its reply instead of using the API. Kinaera can read it, but it may be less reliable.",
        content: response.content,
        arguments: call.arguments,
        seconds,
      };
}

/** What `read_prompt_manifest` tells your kinwriter. */
export interface PromptManifest {
  /** Each section of the instructions, in order, and its size. */
  layers: { title: string; characters: number }[];
  /** The conversation: in full, summarized, or left out. */
  messages: { inFull: number; summarized: string[]; leftOut: number; keptInFull: number; verbatimSlotsFree: number };
  /** Journal entries in the prompt (by id), and how many have faded. */
  journal: { included: string[]; faded: number };
  /** Whether the short version of the self-page is in, and how long it is. */
  selfPage: { characters: number };
  /** Notebook entries pinned to this channel. */
  pinned: string[];
}

/**
 * What a turn in this channel would put in front of your kinwriter: built from
 * the same prompt the turn sends (with the journal's text left out, since
 * the tool log could show this).
 */
export function promptManifest(store: Store, channelId: string, profile?: Profile): PromptManifest {
  const channel = store.getChannel(channelId);
  const system = promptForChannel(store, channelId, { profile, preview: true, keepSelfNotes: true })[0]!.content;
  const layers = system
    .split(/^## /m)
    .filter((part) => part.trim())
    .map((part) => {
      const [title, ...rest] = part.split("\n");
      return { title: title!.trim(), characters: rest.join("\n").trim().length };
    });
  const messages = store.getMessages(channelId);
  const { start, memory = {} } = promptWindow(store, channel, messages);
  const summarized = [
    ...(memory.story ? ["the story so far"] : []),
    ...(memory.scenes ?? []).map((s) => s.heading),
    ...(memory.earlier ? ["earlier in this scene or conversation"] : []),
  ];
  const posts = (list: Message[]) => list.filter((m) => m.kind === "post").length;
  const kept = store.verbatim.ids(channelId);
  const older = messages.slice(0, start);
  const journal = store.journal.forPrompt();
  return {
    layers,
    messages: {
      inFull: posts(messages.slice(start)),
      summarized,
      leftOut: summarized.length ? 0 : posts(older.filter((m) => !kept.includes(m.id))),
      keptInFull: older.filter((m) => kept.includes(m.id)).length,
      verbatimSlotsFree: Math.max(0, VERBATIM_SLOTS - kept.length),
    },
    journal: { included: journal.entries.map((e) => e.id.slice(0, 6)), faded: journal.faded },
    selfPage: { characters: store.selfPage.view().standing.length },
    pinned: store.notebook.forPrompt(channelId).pinned.map((p) => p.entry.name),
  };
}
