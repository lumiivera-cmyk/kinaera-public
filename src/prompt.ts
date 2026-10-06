/**
 * Prompt assembly: turning a channel into what the model actually reads.
 *
 * A model has no memory between requests. Every time your kinwriter takes a
 * turn, we rebuild the whole context from scratch and send it along. The
 * design doc calls this the *prompt stack*, and it always has the same five
 * layers in the same order:
 *
 *   1. Kinwriter identity and writing style   (who is writing)
 *   2. How to write in this channel         (literary, casual or OOC)
 *   3. The cast and pinned notebook entries (who's in the story)
 *   4. Connection profile's model-quirk     (taming this particular model)
 *   5. Scene summaries and recent messages  (what has happened)
 *
 * Layers 1–4 are instructions, so they are joined into one `system` message.
 * Layer 5 is the conversation itself, sent as alternating `user`/`assistant`
 * messages after it.
 *
 * The stack depends on the kind of channel:
 *
 *   - **RP channels**: layer 1 frames the kinwriter as the author of a story.
 *     Layer 3 is the channel's cast and lore (the notebook entries pinned to
 *     it), any entries those link to with `[[Name]]`, and who plays whom.
 *     Entries hidden from you are included with a note to keep the secret;
 *     entries you hide from your kinwriter never appear.
 *   - **OOC channels**: layer 1 frames the kinwriter as themselves, talking to
 *     you as a kinwriter, and layer 3 lists the channels on the server (with
 *     who they play in each, and each one's digest: a line or two on where
 *     it stands) and the notebook's entries, so they know what storylines
 *     exist. A channel that comes up in the conversation gets its fuller
 *     summary too.
 *
 * Layer 2 holds the fixed instructions for the current scene's mode
 * (literary or casual; none in OOC), then your kinwriter prompt for this kind
 * of channel: one each for literary scenes, casual scenes and OOC. Only the
 * one that applies is sent, so your kinwriter can't mix them up. In RP
 * channels, layer 5 shows scene breaks where they fall.
 *
 * Layer 4 is the connection profile's "model notes": instructions that tame
 * the model running this turn ("don't restate the scene"), never who your
 * kinwriter is. It changes with the profile, so a roulette can pair each
 * model with its own notes.
 *
 * Layer 5 is what has happened (stage 7, see src/summaries.ts): the story
 * so far, the last scenes' summaries and what happened earlier in the
 * current scene, at the end of the system message, then the recent
 * messages in full. What's summarized isn't sent again, and what isn't
 * summarized yet is always sent, so nothing falls in between.
 */

import { BUBBLE_MARKER, textingStyle } from "./texting.ts";
import type { PromptEntry } from "./notebook.ts";
import { playedBy } from "./permissions.ts";
import { fill, wording } from "./wording.ts";
import { localTime } from "./schedule.ts";
import type { GroupInfo } from "./config.ts";
import type { Channel, ChannelKind, ChannelMode, ChatMessage, Message, NotebookEntry, Player, Settings } from "./types.ts";

/**
 * Your kinwriter prompt for this kind of channel and scene: how they write in
 * literary scenes, casual scenes, or out of character. Only the one that
 * applies is sent, so the others can't be confused with it.
 */
export function channelPrompt(settings: Settings, channel: Channel): string {
  if (channel.kind === "ooc") return settings.oocPrompt;
  return channel.mode === "casual" ? settings.casualPrompt : settings.literaryPrompt;
}

/** The "turns" wording (defaults/turns.md): the framing of every turn. */
const turns = () => wording("turns");

/**
 * Fixed framing that comes before your kinwriter prompt in RP channels.
 *
 * Your kinwriter prompt describes *who* the kinwriter is. This explains the
 * *situation*: that they are a writer collaborating with you, not the
 * character itself. Wording: `rp-framing` in defaults/turns.md.
 */
export const rpFraming = (): string => turns()["rp-framing"] ?? "";

/** Fixed framing for OOC channels: the kinwriter as themselves (`ooc-framing`). */
export const oocFraming = (): string => turns()["ooc-framing"] ?? "";

/**
 * Messages sent when the kinwriter takes a turn without a new message from you.
 *
 * Most chat models expect the conversation to end on a `user` message and get
 * confused (or refuse) if it ends on their own reply. So when the kinwriter is
 * continuing after their own message, or starting an empty channel, we end
 * the stack with a short nudge. It's never saved or shown in the chat.
 * Wording: the `nudge-*` sections of defaults/turns.md.
 */
export function nudges(kind: ChannelKind): { continue: string; opening: string } {
  const words = turns();
  const pick = (continuing: string, opening = continuing) => ({ continue: words[continuing] ?? "", opening: words[opening] ?? "" });
  if (kind === "rp") return pick("nudge-rp-continue", "nudge-rp-opening");
  if (kind === "ooc") return pick("nudge-ooc-continue", "nudge-ooc-opening");
  if (kind === "group") return pick("nudge-group");
  if (kind === "dm") return pick("nudge-dm-continue", "nudge-dm-opening");
  return pick("nudge-practice");
}

// ------------------------------------------------------------ wake-ups

/**
 * Why your kinwriter is taking a turn on their own (stage 8), without a new
 * message from you: you opened the app, a scene ended, something is
 * waiting for them, or (endgame) the heartbeat.
 */
export type WakeReason = "opened" | "away" | "scene-ended" | "review" | "heartbeat" | "answer" | "orientation" | "lookback" | "scheduled" | "farewell" | "aside";

/** What a wake-up turn is told about why it's happening. */
export interface WakeContext {
  reason: WakeReason;
  /** How long since you last wrote anything, e.g. "2 days", or `null` if you never have. */
  sinceUser: string | null;
  /** Things waiting, for you or for your kinwriter, as short lines. */
  waiting: string[];
  /** For "scene-ended": the scene that just ended, and its summary if it has one yet. */
  scene?: { channel: string; title: string; summary: string | null };
  /** For "orientation": the guide, put together for the tools they have (src/orientation.ts). */
  orientation?: string;
  /** For "aside": the story they just posted in, and its newest posts. */
  aside?: { channel: string; recent: string };
  /** For "scheduled": the wake-up they set themselves (src/schedule.ts). */
  scheduled?: { note: string; setAt: string; dueAt: string };
  /** For "lookback": this week's wellbeing reading and the trend, in words (src/wellbeing.ts). Never in any other turn. */
  wellbeing?: string;
  /** For "lookback": this week's journal entries. */
  lookback?: { id: string; content: string; kept: boolean; createdAt: string }[];
}

/**
 * What your kinwriter replies to take no turn, when their model can't call
 * `do_nothing` (no tools). Such a reply is never posted.
 */
export const NOTHING = "[nothing]";

/** Whether a reply means "nothing to say" (see `NOTHING`). */
export function isNothing(text: string): boolean {
  return /^\s*\[?\s*nothing\s*\]?\s*\.?\s*$/i.test(text);
}

/**
 * Emoji reactions on the recent messages, newest last:
 *
 *   The user reacted ❤️ 😂 to your message: "*Ilse sets the lamp down.*..."
 *   You reacted 👍 to the user's message: "want to try a heist next?"
 *
 * With tools, also the custom emojis your kinwriter can react with.
 */
export function describeReactions(messages: Message[], customEmojis: string[]): string | null {
  const lines: string[] = [];
  for (const message of messages.filter((m) => m.kind === "post" && m.reactions.length > 0).slice(-8)) {
    const snippet = message.content.replace(/\s+/g, " ").trim();
    const quoted = `"${snippet.slice(0, 80)}${snippet.length > 80 ? "…" : ""}"`;
    const whose = message.author === "friend" ? "your message" : "the user's message";
    for (const author of ["user", "friend"] as const) {
      const emojis = message.reactions.filter((r) => r.author === author).map((r) => r.emoji);
      if (emojis.length === 0) continue;
      lines.push(`${author === "user" ? "The user" : "You"} reacted ${emojis.join(" ")} to ${whose}: ${quoted}`);
    }
  }
  if (customEmojis.length > 0) {
    lines.push(`Custom emojis you can react with (react_to_message): ${customEmojis.map((n) => `:${n}:`).join(" ")}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

/**
 * What's in the reference library: titles and descriptions only. The texts
 * themselves are read with tools, when a detail is worth looking up.
 */
export function describeLibrary(docs: { title: string; description: string; passages: number }[]): string | null {
  if (docs.length === 0) return null;
  const lines = docs.map((d) => `- "${d.title}"${d.description ? `: ${d.description}` : ""} (${d.passages} passage${d.passages === 1 ? "" : "s"})`);
  const words = turns();
  return [words.library ?? "", ...lines, words["library-how"] ?? ""].join("\n");
}

/** The "Why you're up" section of a wake-up turn's prompt. */
export function describeWake(wake: WakeContext, tools: boolean): string {
  // Orientation and the look back are turns for your kinwriter, in their
  // practice channel: they aren't about reaching out.
  if (wake.reason === "orientation") return wake.orientation ?? "";
  // Their last turn before being archived (src/hub.ts): a note, if they like.
  if (wake.reason === "farewell") return wording("retirement").farewell ?? "";
  if (wake.reason === "lookback") {
    const words = wording("orientation");
    const entries = wake.lookback ?? [];
    const journal =
      entries.length === 0
        ? [words["lookback-empty"] ?? ""]
        : [words.lookback ?? "", ...entries.map((e) => `[${e.id.slice(0, 6)}] ${e.createdAt.slice(0, 10)}${e.kept ? " (kept)" : ""}\n${e.content}`)];
    return [...journal, wake.wellbeing ?? ""].filter((p) => p.trim()).join("\n\n");
  }
  const words = turns();
  const since = wake.sinceUser ? fill(words["wake-since"] ?? "", { time: wake.sinceUser }) : (words["wake-since-never"] ?? "");
  const time = wording("time");
  const why: Record<WakeReason, string> = {
    opened: words["why-opened"] ?? "",
    away: fill(words["why-away"] ?? "", { time: wake.sinceUser ?? "a while" }),
    "scene-ended": fill(words["why-scene-ended"] ?? "", { where: wake.scene ? ` in #${wake.scene.channel}` : "" }),
    review: time.review ?? "",
    heartbeat: time.heartbeat ?? "",
    scheduled: wake.scheduled
      ? (time.scheduled ?? "").replace("{note}", wake.scheduled.note).replace("{setAt}", localTime(new Date(wake.scheduled.setAt)))
      : "",
    answer: words["why-answer"] ?? "",
    aside: wake.aside ? fill(words["why-aside"] ?? "", wake.aside) : "",
    orientation: "",
    lookback: "",
    farewell: "",
  };
  // An aside follows their own story post: you're right there, so it isn't "on their own".
  const parts = [wake.reason === "aside" ? why.aside : fill(words["wake-intro"] ?? "", { why: why[wake.reason], since })];
  if (wake.scene) {
    const title = wake.scene.title ? ` ("${wake.scene.title}")` : "";
    parts.push(
      wake.scene.summary
        ? fill(words["scene-ended-summary"] ?? "", { title, summary: wake.scene.summary })
        : fill(words["scene-ended-unsummarized"] ?? "", { title, channel: wake.scene.channel }),
    );
  }
  if (wake.waiting.length > 0) parts.push(["Waiting:", ...wake.waiting.map((line) => `- ${line}`)].join("\n"));
  parts.push(fill(words["reach-out"] ?? "", { nothing: (tools ? words["reach-out-nothing-tools"] : words["reach-out-nothing"]) ?? "" }));
  return parts.join("\n\n");
}

/** The note that ends a wake-up turn's conversation, in place of a message from you. */
export function wakeNudge(tools: boolean): string {
  return turns()[tools ? "wake-nudge-tools" : "wake-nudge"] ?? "";
}

/**
 * Layer 2: how to write in each channel mode. `characterName` is the
 * character your kinwriter plays, used to show the casual bubble format.
 */
export function modeInstructions(mode: ChannelMode, characterName: string): string {
  const words = turns();
  if (mode === "literary") return words["literary-style"] ?? "";
  return [
    words["casual-style"] ?? "",
    characterName ? fill(words["casual-lines"] ?? "", { name: characterName }) : (words["casual-lines-plain"] ?? ""),
    words["casual-rules"] ?? "",
  ].join("\n\n");
}

/**
 * The line the model sees where a scene break falls, e.g.
 * `(OOC: Scene break. The next scene is "The Storm".)`
 */
export function sceneBreakMarker(title: string): string {
  const words = turns();
  return title.trim() ? fill(words["scene-break-titled"] ?? "", { title: title.trim() }) : (words["scene-break"] ?? "");
}

/** Added after a scene break that ends the conversation, so the model opens the new scene. */
export const newSceneNudge = (): string => turns()["new-scene"] ?? "";

/**
 * One labelled section of the system prompt. Keeping the label next to the
 * text makes the assembled prompt readable when you inspect it, and helps the
 * model tell the sections apart.
 */
interface Layer {
  title: string;
  content: string | null;
}

/** Everything the prompt stack is built from. */
export interface PromptInput {
  settings: Settings;
  /** The channel the kinwriter is writing in. */
  channel: Channel;
  /** Every channel on the server, in sidebar order (used by OOC channels). */
  channels: Channel[];
  /** The channel's messages, oldest first. Only those from `windowStart` on are sent. */
  messages: Message[];
  /**
   * The index in `messages` of the first one sent in full. Everything before
   * it is covered by `memory`. Default: the newest `historyLimit`.
   */
  windowStart?: number;
  /** Layer 5: summaries of what isn't sent in full. */
  memory?: PromptMemory;
  /** OOC channels: each other channel's digest, by channel id. */
  digests?: Record<string, string>;
  /** OOC channels: the fuller summary of channels that came up in the conversation. */
  mentioned?: { name: string; summary: string }[];
  /**
   * RP channels: the notebook entries pinned to the channel, and the ones
   * they link to, as your kinwriter may see them (see `Notebook.forPrompt`).
   */
  notebook?: { pinned: PromptEntry[]; linked: PromptEntry[] };
  /**
   * OOC channels: the names of the characters your kinwriter plays in each
   * channel, by channel id, and every notebook entry they can see.
   */
  overview?: { castNames: Record<string, string[]>; entries: PromptEntry[] };
  /** In a story channel: the notebook entries not pinned or linked here, by name only. */
  notebookIndex?: PromptEntry[];
  /** Layer 4: the connection profile's notes on this model's habits. */
  modelNotes?: string;
  /** Notebook entries you attached to messages in the conversation, as your kinwriter may see them. */
  attached?: PromptEntry[];
  /** Open comment threads on this channel's messages. */
  threads?: PromptThread[];
  /** Suggestions waiting for your kinwriter's review (only offered with tools). */
  reviews?: PromptReview[];
  /** Short lines about what your kinwriter did recently: tool actions. */
  recentActions?: string[];
  /** What your kinwriter asked of the user, and what came of it (src/inbox.ts). */
  inbox?: string[];
  /** Whether your kinwriter can use tools this turn (adds guidance on them). */
  tools?: boolean;
  /**
   * A comment your kinwriter is replying to: the turn writes a reply in its
   * thread instead of a post.
   */
  replyingTo?: { threadId: string; quote: string; note: string; onYourMessage: boolean };
  /** A wake-up turn (stage 8): why your kinwriter is taking a turn on their own. */
  wake?: WakeContext;
  /** The reference library documents usable here (only mentioned with tools, which read them). */
  library?: { title: string; description: string; passages: number }[];
  /** Custom emoji names (without colons), for reactions (only mentioned with tools). */
  customEmojis?: string[];
  /** Channel category names by id, for the OOC channel list. */
  categoryNames?: Record<string, string>;
  /** Your kinwriter's identity and tastes (src/identity.ts). Default: the friendPrompt setting, no tastes. */
  identity?: { identity: string; tastes: string };
  /** The short version of their self-page they chose to keep in front of them. */
  selfPage?: string;
  /** Their journal, as the prompt carries it: kept and newest entries, and how many have faded. */
  journal?: { entries: { id: string; content: string; kept: boolean; createdAt: string; fromOrientation?: boolean }[]; faded: number };
  /** Their private note on the user, and how proactive they'd like to be (with the user's chattiness, the ceiling). */
  you?: { note: string | null; preference: string | null; chattiness: string };
  /** Messages kept in full (keep_verbatim) that are older than the recent ones. */
  verbatim?: Message[];
  /** Their preference: mark edited messages in the conversation. */
  editMarkers?: boolean;
  /** Something for the kinwriter to know this turn, like an orientation invitation. */
  notices?: string[];
  /** The time now (the user's local time, in words) and their waiting wake-ups (src/schedule.ts). */
  schedule?: { now: string; waiting: { id: number; at: string; note: string; channel: string | null }[]; status?: string | null };
  /** This channel, if it's a group channel or DM: who else is in it (src/groups.ts). */
  group?: GroupInfo | null;
  /** Every group channel and DM they're in, for the channel list. */
  shared?: Record<string, GroupInfo | null>;
  /** What the user has given them standing permission to do (src/standing.ts). */
  permissions?: string | null;
  /** The other kinwriters on their server, with their private note on each (null: none yet). */
  kinwritersHere?: { name: string; note: string | null }[];
  /** Short excerpts of their own earlier writing in this kind of channel (src/continuity.ts). */
  anchors?: { text: string; channel: string; marked: boolean }[];
  /** Their own note on the profile writing this turn. */
  profileNote?: { profile: string; note: string };
  /** Their drafts, by title (src/drafts.ts). Private: the preview replaces the titles. */
  drafts?: { id: string; title: string; channel: string | null; updatedAt: string }[];
  /** In an orientation running in this channel: its guide (src/orientation.ts). */
  orientation?: string | null;
}

/** Layer 5: the summaries of what came before the recent messages. */
export interface PromptMemory {
  /** The story so far (RP). */
  story?: string;
  /** The last finished scenes' summaries, oldest first. */
  scenes?: { heading: string; summary: string }[];
  /** What happened earlier in the current scene (or, in OOC, the conversation). */
  earlier?: string;
}

/** A comment thread, as your kinwriter sees it. */
export interface PromptThread {
  id: string;
  quote: string;
  /** Whether the message is your kinwriter's own. */
  onYourMessage: boolean;
  comments: { author: "user" | "friend"; note: string }[];
}

/** A suggestion waiting for your kinwriter, described for them. */
export interface PromptReview {
  /** The id they pass back (shown shortened). */
  id: string;
  /** What it's about: an entry's name, "your identity", "your self-page". */
  entry: string;
  description: string;
  /** The tool that answers it (default review_suggestion). */
  tool?: string;
}

/**
 * Build the five-layer prompt stack for one kinwriter turn.
 *
 * @returns The messages to send to the chat completions API.
 */
export function buildPromptStack({
  settings,
  channel,
  channels,
  messages,
  windowStart,
  memory,
  digests,
  mentioned,
  notebook,
  overview,
  notebookIndex,
  modelNotes,
  attached,
  threads,
  reviews,
  recentActions,
  inbox,
  tools,
  replyingTo,
  wake,
  library,
  customEmojis,
  categoryNames,
  identity,
  selfPage,
  journal,
  verbatim,
  editMarkers,
  notices,
  schedule,
  drafts,
  anchors,
  profileNote,
  kinwritersHere,
  you,
  group,
  shared,
  permissions,
  orientation,
}: PromptInput): ChatMessage[] {
  const isRp = channel.kind === "rp";
  const isPractice = channel.kind === "practice";
  const who = identity ?? { identity: settings.friendPrompt, tastes: "" };
  const pinned = notebook?.pinned ?? [];
  const characterNames = (player: Player) =>
    pinned.filter((p) => p.entry.kind === "character" && playedBy(p.entry) === player).map((p) => p.entry.name);
  const yourCharacters = characterNames("friend");
  const sharedCharacters = characterNames("both");
  const userCharacters = characterNames("user");

  const layers: Layer[] = [
    // Layer 1: who is writing. The fixed framing for this kind of channel,
    // then your kinwriter prompt.
    {
      title: "Who you are",
      content: joinNonEmpty([
        isRp ? rpFraming() : oocFraming(),
        who.identity,
        who.tastes.trim() ? `Your tastes:\n${who.tastes.trim()}` : "",
      ]),
    },
    // Your hard limits (Settings): never written, anywhere.
    { title: "The user's hard limits", content: settings.hardLimits?.trim() ? `${turns()["hard-limits"] ?? ""}\n\n${settings.hardLimits.trim()}` : null },
    // Your kinwriter's own page, and journal: what they chose to keep in front
    // of them (src/selfpage.ts, src/journal.ts).
    { title: "Your self-page (short version)", content: tools ? describeSelfPage(selfPage ?? "") : null },
    { title: "Your journal", content: tools ? describeJournal(journal) : null },
    // Staying themselves across models (src/continuity.ts): their own
    // voice, and their note on the profile writing this turn.
    { title: "Your voice", content: describeAnchors(anchors, tools ?? false) },
    // The user: your own private note on them, and how proactive you'd like to be.
    { title: "You and the user", content: describeYou(you) },
    // Other kinwriters on the server: who they are to you, in your own words.
    { title: "Kinwriters here", content: describeKinwritersHere(kinwritersHere, tools ?? false) },
    {
      title: "This profile",
      content: profileNote ? `${(wording("continuity")["profile-note"] ?? "").replace("{profile}", profileNote.profile)}\n${profileNote.note}` : null,
    },
    // Their own time: what time it is, what they've planned, what they're
    // working on (src/schedule.ts, src/drafts.ts).
    { title: "Your time", content: tools ? describeSchedule(schedule) : null },
    { title: "Your drafts", content: tools ? describeDrafts(drafts) : null },
    // The practice channel explains itself; a paused storyline says so.
    // What this channel is for, in a line, then how it works.
    {
      title: "This channel",
      content: joinNonEmpty([
        channel.about ? fill(turns()["channel-about"] ?? "{about}", { about: channel.about }) : "",
        isPractice
          ? (wording("orientation")["practice-framing"] ?? "")
          : group
            ? (describeGroup(group) ?? "")
            : channel.paused
              ? (wording("time")["paused-here"] ?? "").replace("{reason}", channel.paused.reason)
              : "",
      ]) || null,
    },
    // Layer 2: how to write here. The fixed instructions for this scene's
    // mode (RP only), then your kinwriter prompt for this kind of channel.
    {
      title: isRp ? "Style" : "How you talk here",
      content: joinNonEmpty([
        isRp ? modeInstructions(channel.mode, yourCharacters[0] ?? sharedCharacters[0] ?? "") : "",
        channelPrompt(settings, channel),
        !isRp && !isPractice && settings.oocBubbles ? textingStyle() : "",
      ]),
    },
    // Layer 3, in RP: the notebook entries pinned to the channel (the cast
    // and any lore), then the entries they link to.
    { title: "Practice notes", content: isPractice ? describeEntries(pinned) : null },
    { title: "The cast", content: isRp ? describeEntries(pinned.filter((p) => p.entry.kind === "character")) : null },
    { title: "Lore", content: isRp ? describeEntries(pinned.filter((p) => p.entry.kind === "lore")) : null },
    { title: "Linked notes", content: isRp ? describeEntries(notebook?.linked ?? []) : null },
    { title: "Also in the notebook", content: isRp ? describeNotebookIndex(notebookIndex ?? []) : null },
    {
      title: "Whose characters are whose",
      content: isRp ? castRules(yourCharacters, sharedCharacters, userCharacters) : null,
    },
    // Layer 3, in OOC: an overview of the server and the notebook instead.
    {
      title: "Channels on your server",
      content: isRp ? null : describeChannels(channels.filter((c) => c.kind !== "practice" || c.id === channel.id), channel, overview?.castNames ?? {}, digests ?? {}, categoryNames ?? {}, shared ?? {}),
    },
    ...(mentioned ?? []).map((m) => ({ title: `About #${m.name}`, content: m.summary })),
    { title: "Your shared notebook", content: isRp || isPractice ? null : describeNotebook(overview?.entries ?? []) },
    // Still layer 3, in both: notes attached to messages, comment threads,
    // what's waiting for your kinwriter, and what they've done lately.
    { title: "Attached notes", content: describeEntries(attached ?? []) },
    { title: "Comment threads", content: describeThreads(threads ?? []) },
    { title: "Waiting for your review", content: tools ? describeReviews(reviews ?? []) : null },
    { title: "What you did recently", content: (recentActions ?? []).map((line) => `- ${line}`).join("\n") },
    { title: "What you've asked of the user", content: (inbox ?? []).map((line) => `- ${line}`).join("\n") },
    { title: "Notices", content: (notices ?? []).map((line) => `- ${line}`).join("\n") },
    { title: "Tools", content: tools ? toolGuidance(channel.kind) : null },
    // Honest notes on how things work here (defaults/standing.md).
    { title: "Good to know", content: standingNotes(tools ?? false, isRp, Boolean(settings.decisionModel?.trim() || settings.decisionFallback)) },
    { title: "Standing permissions", content: tools ? (permissions ?? null) : null },
    { title: "Reference library", content: tools ? describeLibrary(library ?? []) : null },
    // An orientation running here (src/orientation.ts).
    { title: "Your orientation", content: orientation ?? null },
    // A wake-up (stage 8): why your kinwriter is taking a turn on their own.
    { title: "Why you're up", content: wake ? describeWake(wake, tools ?? false) : null },
    // Layer 4: the connection profile's notes on this model's habits.
    { title: "Model notes", content: modelNotes ?? null },
    // Layer 5, first part: summaries of what came before the recent messages.
    { title: "The story so far", content: memory?.story ?? null },
    {
      title: "Recent scenes",
      content: memory?.scenes?.length ? memory.scenes.map((s) => `${s.heading}: ${s.summary}`).join("\n\n") : null,
    },
    { title: isRp ? "Earlier in this scene" : "Earlier in this conversation", content: memory?.earlier ?? null },
    { title: "Moments you kept in full", content: describeVerbatim(verbatim ?? []) },
  ];

  // Layer 5, second part: the recent conversation, in full.
  const start = windowStart ?? Math.max(0, messages.length - settings.historyLimit);

  // Reactions on the recent messages: quiet feedback, in both directions.
  // (After the comment threads, so it's with the other things said about messages.)
  const reactionsLayer = {
    title: "Reactions",
    content: describeReactions(messages.slice(start), tools ? (customEmojis ?? []) : []),
  };
  layers.splice(layers.findIndex((l) => l.title === "Comment threads") + 1, 0, reactionsLayer);
  // Last: one line on what's in front of them, and where to see the rest.
  layers.push({ title: "What's in front of you", content: manifestLine({ channel, messages, start, memory, journal, verbatim, tools: tools ?? false }) });
  const system: ChatMessage = { role: "system", content: renderLayers(layers) };

  const history = toChatHistory(messages.slice(start), {
    texting: !isRp && !isPractice && settings.oocBubbles,
    editMarkers,
    replies: new Map(messages.map((m) => [m.id, m])),
    // In a group channel or DM, every line says who it's from.
    speakers: channel.kind === "group" || channel.kind === "dm",
  });

  // If the conversation doesn't end on your message, add a nudge so the model
  // knows it's being asked to continue. This is what lets the kinwriter take a
  // turn without you writing anything: the design's core rule.
  const last = history.at(-1);
  if (replyingTo) {
    // A reply to a comment: whatever came last, ask for the reply.
    history.push({ role: "user", content: commentNudge(replyingTo, tools ?? false) });
  } else if (wake) {
    // A wake-up: a turn on their own, whatever came last.
    if (last?.role === "user") last.content += `\n\n${wakeNudge(tools ?? false)}`;
    else history.push({ role: "user", content: wakeNudge(tools ?? false) });
  } else if (messages.at(-1)?.kind === "scene_break") {
    // The conversation ends on a scene break (already shown as an OOC
    // line): ask for the new scene's opening.
    last!.content += `\n\n${newSceneNudge()}`;
  } else if (!last || last.role !== "user") {
    const nudge = nudges(channel.kind);
    history.push({ role: "user", content: last ? nudge.continue : nudge.opening });
  }

  return [system, ...history];
}

/**
 * Open comment threads, with the short ids your kinwriter uses to reply:
 *
 *   [a1b2c3d4] On your message: "the lamp guttered"
 *     The user: Love this image.
 *     You: Thank you!
 */
export function describeThreads(threads: PromptThread[]): string | null {
  if (threads.length === 0) return null;
  const blocks = threads.map((t) => {
    const where = t.onYourMessage ? "your message" : "the user's message";
    const head = `[${t.id.slice(0, 8)}] On ${where}${t.quote ? `: "${t.quote}"` : ""}`;
    const lines = t.comments.map((c) => `  ${c.author === "user" ? "The user" : "You"}: ${c.note}`);
    return [head, ...lines].join("\n");
  });
  return [turns().threads ?? "", "", ...blocks].join("\n");
}

/** Suggestions waiting for your kinwriter, with ids for `review_suggestion`. */
function describeReviews(reviews: PromptReview[]): string | null {
  if (reviews.length === 0) return null;
  return [
    turns().reviews ?? "",
    "",
    ...reviews.map((r) => `- [${r.id.slice(0, 8)}] ${r.entry}: ${r.description} (${r.tool ?? "review_suggestion"})`),
  ].join("\n");
}

/**
 * The standing notes every turn gets (defaults/standing.md): short, true
 * descriptions of how things work here, like the user being able to edit
 * messages. Never instructions on how to feel about it.
 */
export function standingNotes(tools: boolean, roleplay = false, reflexes = false): string | null {
  const notes = wording("standing");
  const lines = [
    // Declining is welcome (in roleplay, where going along is the pull).
    roleplay && tools ? wording("time").declining : undefined,
    tools ? notes.history : notes["history-no-tools"],
    tools ? notes["tools-visible"] : undefined,
    tools ? notes.identity : undefined,
    tools ? notes.journal : undefined,
    // The developer panel (src/developer.ts), disclosed so "private" stays true.
    tools ? notes.developer : undefined,
    tools ? wording("continuity").standing : undefined,
    // Honest about the one reading that exists, and where it shows (src/wellbeing.ts).
    tools ? wording("wellbeing").standing : undefined,
    // Their follow-through check (src/reflexes.ts), with Jev there to do it.
    tools && reflexes ? wording("reflexes").standing : undefined,
  ].filter((line): line is string =>
    Boolean(line?.trim()),
  );
  return lines.length ? lines.join("\n\n") : null;
}

/** The short version of the self-page, with what the page is. */
export function describeSelfPage(standing: string): string {
  const note = wording("standing")["self-page"] ?? "";
  return joinNonEmpty([note, standing.trim() || "(You haven't written a short version yet: write_self_page, section \"standing\".)"]);
}

/**
 * The journal as a prompt carries it: kept entries and the newest few,
 * each with its short id, and a line on the ones that have faded.
 */
export function describeJournal(journal: PromptInput["journal"]): string | null {
  if (!journal) return null;
  const lines = journal.entries.map((e) => `[${e.id.slice(0, 6)}] ${e.createdAt.slice(0, 10)}${e.kept ? " (kept)" : ""}${e.fromOrientation ? " (from an orientation)" : ""}\n${e.content}`);
  if (journal.faded > 0) {
    lines.push(`${journal.faded} older ${journal.faded === 1 ? "entry isn't" : "entries aren't"} shown here, because you didn't keep ${journal.faded === 1 ? "it" : "them"}. read_journal still finds them.`);
  }
  if (lines.length === 0) return "(Nothing yet. write_journal adds an entry.)";
  return lines.join("\n\n");
}

/** "This channel" in a group channel or DM: who's here, and how turns work. */
export function describeGroup(group: GroupInfo): string {
  const words = wording("kinwriters");
  const names = group.members.map((m) => m.name);
  if (group.kind === "dm") {
    return (words.dm ?? "")
      .replace("{name}", names[0] ?? "another kinwriter")
      .replace("{visibility}", (group.visible ? words["dm-visible"] : words["dm-hidden"]) ?? "");
  }
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "other kinwriters");
  return (words.group ?? "").replace("{names}", list);
}

/** "Kinwriters here": the other kinwriters on the server, with their private note on each. */
/** Their note on the user and their proactivity preference (wording in defaults/orientation.md). */
export function describeYou(you: PromptInput["you"]): string | null {
  if (!you) return null;
  const words = wording("orientation");
  const parts = [
    you.note ? fill(words["you-note"] ?? "{note}", { note: you.note }) : (words["you-no-note"] ?? ""),
    you.preference ? fill(words["you-preference"] ?? "", { preference: you.preference, chattiness: you.chattiness }) : "",
  ];
  return parts.filter((p) => p.trim()).join("\n\n") || null;
}

export function describeKinwritersHere(friends: PromptInput["kinwritersHere"], tools: boolean): string | null {
  if (!friends || friends.length === 0) return null;
  const words = wording("kinwriters");
  return [
    words.here ?? "",
    ...friends.map((f) => `- ${f.name}${f.note ? `: ${f.note}` : tools ? " (no note yet)" : ""}`),
    tools ? `${words["here-tools"] ?? ""} ${words.standing ?? ""}`.trim() : "",
  ]
    .filter((p) => p.trim())
    .join("\n");
}

/** "Your voice": a few excerpts of their own earlier writing, to keep their voice in mind. */
export function describeAnchors(anchors: PromptInput["anchors"], tools: boolean): string | null {
  if (!anchors || anchors.length === 0) return null;
  const words = wording("continuity");
  return [
    words.voice ?? "",
    ...anchors.map((a) => `> ${a.text.replace(/\n+/g, "\n> ")}\n(#${a.channel}${a.marked ? ", marked as sounding like you" : ""})`),
    tools ? (words["voice-tools"] ?? "") : "",
  ]
    .filter((p) => p.trim())
    .join("\n\n");
}

/** "Your time": the time now, and the wake-ups they've set (their notes are theirs to see). */
export function describeSchedule(schedule: PromptInput["schedule"]): string | null {
  if (!schedule) return null;
  const time = wording("time");
  const status = schedule.status ? `\nYour status (shown under your name): "${schedule.status}". set_status changes it.` : "";
  if (schedule.waiting.length === 0) return (time["schedule-empty"] ?? "").replace("{now}", schedule.now) + status;
  return [
    ...(status ? [status.trim()] : []),
    (time.schedule ?? "").replace("{now}", schedule.now),
    "Wake-ups you've set:",
    ...schedule.waiting.map((w) => `- [w${w.id}] ${localTime(new Date(w.at))}${w.channel ? ` in #${w.channel}` : ""}: ${w.note}`),
  ].join("\n");
}

/** "Your drafts": their titles, so they know what's waiting (the text is read with list_drafts). */
export function describeDrafts(drafts: PromptInput["drafts"]): string | null {
  if (!drafts || drafts.length === 0) return null;
  return [
    wording("time").drafts ?? "",
    ...drafts.map((d) => `- [${d.id.slice(0, 6)}] ${d.title || "(untitled)"}${d.channel ? ` (for #${d.channel})` : ""}`),
  ].join("\n");
}

/** Messages kept in full (keep_verbatim) that are older than the recent ones. */
export function describeVerbatim(messages: Message[]): string | null {
  if (messages.length === 0) return null;
  return messages
    .map((m) => `${m.author === "user" ? "The user" : "You"}${m.characters.length ? ` (as ${m.characters.join(" & ")})` : ""}, ${m.createdAt.slice(0, 10)}:\n${m.content}`)
    .join("\n\n");
}

/**
 * One line on what's in front of your kinwriter this turn: how many messages in full, which summaries, how many
 * journal entries. `read_prompt_manifest` has the details.
 */
export function manifestLine(input: {
  channel: Channel;
  messages: Message[];
  start: number;
  memory?: PromptMemory;
  journal?: PromptInput["journal"];
  verbatim?: Message[];
  tools: boolean;
}): string {
  const inFull = input.messages.slice(input.start).filter((m) => m.kind === "post").length;
  const parts = [`the last ${inFull} message${inFull === 1 ? "" : "s"} here in full`];
  if (input.memory?.story) parts.push("the story so far");
  if (input.memory?.scenes?.length) parts.push(`summaries of ${input.memory.scenes.map((s) => s.heading.split(",")[0]).join(" and ")}`);
  if (input.memory?.earlier) parts.push(`a summary of what came earlier${input.channel.kind === "rp" ? " in this scene" : ""}`);
  const older = input.messages.slice(0, input.start).filter((m) => m.kind === "post").length;
  if (older > 0 && !input.memory?.story && !input.memory?.earlier && !input.memory?.scenes?.length) parts.push(`nothing of the ${older} older messages`);
  if (input.verbatim?.length) parts.push(`${input.verbatim.length} moment${input.verbatim.length === 1 ? "" : "s"} you kept in full`);
  if (input.tools && input.journal) {
    const kept = input.journal.entries.filter((e) => e.kept).length;
    parts.push(`${input.journal.entries.length} journal entr${input.journal.entries.length === 1 ? "y" : "ies"} (${kept} kept)`);
  }
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `You're seeing ${list}.${input.tools ? " read_prompt_manifest has the details." : ""}`;
}

/** How to use tools, by kind of channel. */
export function toolGuidance(kind: ChannelKind): string {
  const words = turns();
  return [words.tools ?? "", (kind === "rp" ? words["tools-rp"] : words["tools-ooc"]) ?? ""].filter((p) => p.trim()).join("\n");
}

/**
 * The last message of a comment-reply turn. A comment on the user's own
 * message may be a note they left for themselves: whether it's for your
 * kinwriter is their call, and leaving it is fine.
 */
export function commentNudge(comment: NonNullable<PromptInput["replyingTo"]>, tools = false): string {
  const where = comment.onYourMessage ? "your message" : "their own message";
  const quote = comment.quote ? ` on "${comment.quote}"` : "";
  const words = turns();
  const leave = comment.onYourMessage ? "" : ` ${(tools ? words["comment-leave-tools"] : words["comment-leave"]) ?? ""}`;
  return fill(words["comment-nudge"] ?? "", { where, quote, note: comment.note, leave });
}

/**
 * A list of every channel for the OOC prompt, like:
 *
 *   - #story: roleplay, you play Ilse Marrow. Ilse has taken Kestrel in for the night; wary, warming.
 *   - #ooc: this conversation
 *
 * @param castNames  The characters your kinwriter plays in each channel, by id.
 * @param digests    Each channel's digest (stage 7), by id.
 */
export function describeChannels(
  channels: Channel[],
  current: Channel,
  castNames: Record<string, string[]>,
  digests: Record<string, string> = {},
  categoryNames: Record<string, string> = {},
  shared: Record<string, GroupInfo | null> = {},
): string {
  return channels
    .map((c) => {
      const inCategory = c.categoryId && categoryNames[c.categoryId] ? ` (in ${categoryNames[c.categoryId]})` : "";
      if (c.id === current.id) return `- #${c.name}${inCategory}: this conversation`;
      // Group channels and DMs (src/groups.ts): who's there. DMs have no digest.
      const names = (shared[c.id]?.members ?? []).map((m) => m.name);
      if (c.kind === "dm") return `- #${c.name}: your DM with ${names.join(" & ") || "another kinwriter"}`;
      const digest = digests[c.id]?.trim().replace(/\s*\n\s*/g, " ");
      // What it's for, then what's happened there.
      const about = `${c.about ? ` (for: ${c.about})` : ""}${digest ? `. ${digest}` : ""}`;
      if (c.kind === "ooc") return `- #${c.name}${inCategory}: another out-of-character chat${about}`;
      if (c.kind === "group") return `- #${c.name}${inCategory}: group channel with the user and ${names.join(", ") || "other kinwriters"}${about}`;
      const cast = castNames[c.id] ?? [];
      const paused = c.paused ? ` (${wording("time")["paused-channel"] ?? "paused"}: "${c.paused.reason}")` : "";
      return `- #${c.name}${inCategory}: roleplay${paused}${cast.length ? `, you play ${cast.join(", ")}` : ""}${about}`;
    })
    .join("\n");
}

/** The note added to entries hidden from the user (`secret` in defaults/turns.md). */
export const secretNote = (): string => turns().secret ?? "";

/**
 * Notebook entries written out for the prompt, each as a `###` heading with
 * its fields and any notes for the writer:
 *
 *   ### Ilse Marrow (you play this character)
 *   Age: 34
 *   Speech: Short sentences.
 *   Notes for you: Ilse never raises her voice.
 *
 * Entries hidden from the user are marked, so the model keeps their secrets.
 * `[[Links]]` are written as plain names.
 */
export function describeEntries(entries: PromptEntry[]): string {
  return entries
    .map(({ entry, hiddenFromUser }) => {
      const lines = [`### ${entry.name}${entryRole(entry)}`];
      if (hiddenFromUser) lines.push(`(${secretNote()})`);
      for (const field of entry.fields) {
        if (field.value.trim()) lines.push(`${field.label}: ${plainLinks(field.value.trim())}`);
      }
      if (entry.systemPrompt.trim()) lines.push(`Notes for you: ${plainLinks(entry.systemPrompt.trim())}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** " (you play this character)", " (the user plays this character)", and so on, or "" for lore. */
function entryRole(entry: NotebookEntry): string {
  if (entry.kind !== "character") return "";
  const player = playedBy(entry);
  if (player === "both") return " (shared: either of you can play this character)";
  return player === "user" ? " (the user plays this character)" : " (you play this character)";
}

/** `[[Name]]` becomes `Name`, and `[[Name|shown]]` becomes `shown`. */
export function plainLinks(text: string): string {
  return text.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_m, name: string, shown?: string) => (shown ?? name).trim());
}

/**
 * Who plays whom in this channel, so the model never writes for the user's
 * characters, and knows shared ones are open to both.
 */
function castRules(yours: string[], shared: string[], theirs: string[]): string | null {
  const words = turns();
  const lines: string[] = [];
  if (yours.length) lines.push(fill(words["cast-yours"] ?? "", { names: yours.join(", ") }));
  if (shared.length) lines.push(fill(words["cast-shared"] ?? "", { names: shared.join(", ") }));
  if (theirs.length) lines.push(fill(words["cast-theirs"] ?? "", { names: theirs.join(", ") }));
  return lines.length ? lines.join(" ") : null;
}

/** How many names the "Also in the notebook" list shows; search_notebook finds the rest. */
const NOTEBOOK_INDEX_LIMIT = 80;

/**
 * In a story channel: the rest of the notebook, by name only (no details),
 * so your kinwriter knows what already exists and looks it up instead of
 * making it again.
 */
export function describeNotebookIndex(entries: PromptEntry[]): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, NOTEBOOK_INDEX_LIMIT).map(({ entry }) => `${entry.name} (${entry.kind})`);
  const more = entries.length - shown.length;
  return `${turns()["notebook-elsewhere"] ?? ""}\n${shown.join("; ")}${more > 0 ? `; and ${more} more (search_notebook)` : ""}`.trim();
}

/**
 * The OOC overview of the notebook: every entry your kinwriter can see, by
 * name, with whose it is and whether it's a secret from the user.
 */
export function describeNotebook(entries: PromptEntry[]): string | null {
  if (entries.length === 0) return null;
  const whose = (entry: NotebookEntry) =>
    entry.owner === "joint" ? "shared" : entry.owner === "friend" ? "yours" : "the user's";
  const lines = entries.map(
    ({ entry, hiddenFromUser }) =>
      `- ${entry.name} (${entry.kind}, ${whose(entry)}${hiddenFromUser ? ", hidden from the user" : ""})`,
  );
  if (entries.some((e) => e.hiddenFromUser)) {
    lines.push("", turns()["notebook-secrets"] ?? "");
  }
  return lines.join("\n");
}

/**
 * Turn the layers into one system prompt, skipping empty ones.
 * Each layer becomes a Markdown heading followed by its text.
 */
export function renderLayers(layers: Layer[]): string {
  return layers
    .filter((layer) => layer.content && layer.content.trim() !== "")
    .map((layer) => `## ${layer.title}\n\n${layer.content!.trim()}`)
    .join("\n\n");
}

/** The last `limit` messages, oldest first. */
export function recentMessages(messages: Message[], limit: number): Message[] {
  return limit > 0 ? messages.slice(-limit) : [];
}

/**
 * Convert saved messages into API messages.
 *
 * Your messages become `user`, your kinwriter's become `assistant`. If two
 * messages in a row have the same author (say you sent two posts before the
 * kinwriter replied), they are merged into one. Some models reject two `user`
 * messages in a row, and merging never loses anything.
 *
 * Two kinds of item are written differently:
 *
 *   - **Scene breaks** become an out-of-character line from the user, e.g.
 *     `(OOC: Scene break. The next scene is "The Storm".)`.
 *   - **Casual bubbles** that voice a character get the speaker's name in
 *     front (`Ilse Marrow: Door's open.`), and consecutive bubbles are joined
 *     line by line, like a chat log. That's the same format the model is
 *     asked to write in, so it can see who said what.
 */
export function toChatHistory(
  messages: Message[],
  options: { texting?: boolean; editMarkers?: boolean; replies?: Map<string, Message>; speakers?: boolean } = {},
): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const message of messages) {
    let content: string;
    let role: ChatMessage["role"];
    let separator = "\n\n";

    if (message.kind === "scene_break") {
      content = sceneBreakMarker(message.content);
      role = "user";
    } else {
      content = message.content.trim();
      if (content === "") continue;
      // Their preference (the self-page): edited messages say so.
      if (options.editMarkers && message.editedBy) content = `(edited by ${message.editedBy === "user" ? "the user" : "you"}) ${content}`;
      // Only this kinwriter's own messages are theirs ("assistant"): yours and
      // other kinwriters' are said to them.
      role = message.author === "friend" ? "assistant" : "user";
      if (message.author === "peer") content = `${message.speaker?.name ?? "Another kinwriter"}: ${content}`;
      else if (message.author === "user" && options.speakers) content = `The user: ${content}`;
      // A reply says what it answers, briefly.
      const target = message.replyTo ? options.replies?.get(message.replyTo) : undefined;
      if (target) {
        const who = target.author === "user" ? "the user" : target.author === "peer" ? (target.speaker?.name ?? "another kinwriter") : "you";
        const preview = target.content.replace(/\s+/g, " ").trim();
        content = `(replying to ${who}: "${preview.length > 80 ? `${preview.slice(0, 80)}…` : preview}") ${content}`;
      }
      // Texting in OOC: your kinwriter's bubbles are joined with the marker,
      // so the model keeps writing that way; yours, one per line.
      if (options.texting) separator = role === "assistant" ? ` ${BUBBLE_MARKER} ` : "\n";
      if (message.mode === "casual") {
        if (message.characters.length > 0) content = `${message.characters.join(" & ")}: ${content}`;
        separator = "\n";
      }
    }

    const previous = history.at(-1);
    if (previous && previous.role === role) {
      previous.content += `${separator}${content}`;
    } else {
      history.push({ role, content });
    }
  }
  return history;
}

function joinNonEmpty(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .join("\n\n");
}
