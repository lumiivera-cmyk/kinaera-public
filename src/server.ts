/**
 * The Kinaera server.
 *
 * This is a small web server, run by Bun in Termux on your phone. It does two
 * jobs:
 *
 *   1. Serves the web app (the files in `public/`) to your browser.
 *   2. Answers the app's API requests under `/api/...`: reading channels and
 *      messages, saving changes, and asking your kinwriter to write.
 *
 * The browser never talks to nanoGPT itself. Your API key stays on the server,
 * and the server is the only thing that reads or writes your data.
 *
 * API overview (all request and response bodies are JSON):
 *
 *   POST   /api/wake                           You opened the app: your kinwriter may wake up (stage 8)
 *   GET    /api/wakeups                        Recent wake-ups, and what came of them
 *   POST   /api/kinwriter/random                 "Surprise me": a new kinwriter's name and prompt, from random ingredients
 *   POST   /api/presence                       The app is (or isn't) on screen: {visible}
 *   POST   /api/heartbeat                      Beat now: a free moment for your kinwriter, if the rules allow
 *   POST   /api/jev/test                      Ask Jev one tiny question, to see if it's reachable and understood
 *   GET    /api/checks                         The check log: every check your kinwriter made
 *
 *   POST   /api/messages/:id/reactions         Add your emoji reaction to a message, or take it back
 *   GET    /api/emojis                         Custom emojis
 *   POST   /api/emojis                         Add a custom emoji: name, and the image as base64
 *   DELETE /api/emojis/:name                   Delete one (and reactions with it)
 *   (Custom emoji images are served at /emojis/<file>.)
 *
 *   GET    /api/library                        The reference library's documents
 *   POST   /api/library                        Add a document: title, description, channelIds and its text
 *   GET    /api/library/search?q=...           Search passages (&doc=id for one document)
 *   PATCH  /api/library/:id                    Change a document's title, description or channels
 *   DELETE /api/library/:id                    Delete a document
 *   GET    /api/library/:id/passages/:seq      Read passages in full (&count=n in a row, up to 10)
 *   GET    /api/state                          Settings, channels, profiles, roulettes, the open inbox,
 *                                              where the kinwriter is writing, and the app version
 *   PUT    /api/settings                       Change settings (any subset of fields)
 *   GET    /api/models                         List models available on nanoGPT
 *
 *   POST   /api/channels                       Create a channel
 *   PATCH  /api/channels/:id                   Rename a channel, or change its style, theme or profile
 *   DELETE /api/channels/:id                   Delete a channel and all its messages
 *   PUT    /api/channels/order                 Put the channels in a new order (and move them between categories)
 *   POST   /api/categories                     Make a channel category
 *   PUT    /api/categories/order               Put the categories in a new order
 *   PATCH  /api/categories/:id                 Rename a category, or fold it up
 *   DELETE /api/categories/:id                 Delete a category (its channels stay)
 *
 *   GET    /api/channels/:id/messages          Every message in a channel, with its tool calls, comment threads
 *                                              and summaries
 *   POST   /api/channels/:id/messages          Send your message (with notes attached), then the kinwriter replies
 *                                              (or add a scene break, if the message is `=====`)
 *   POST   /api/channels/:id/scene-breaks      Add a scene break
 *   DELETE /api/channels/:id/messages          Delete every message in a channel
 *   POST   /api/channels/:id/turn              Kinwriter takes a turn without a new message from you
 *   POST   /api/channels/:id/regenerate        Replace the kinwriter's last reply with a new one (optionally
 *                                              with a given profile)
 *   POST   /api/channels/:id/cancel            Stop the kinwriter's turn in progress (the Stop button)
 *   GET    /api/channels/:id/prompt            The exact prompt stack the next turn would send
 *   GET    /api/health                         The health view: tools and notes by shape, never content
 *   GET    /api/developer                      The developer panel (only with DEVELOPER_PANEL=1)
 *   POST   /api/dry-run                        Build any kind of turn's prompt, and optionally
 *                                              ask the model, without saving anything
 *   GET    /api/channels/:id/tool-log          Every tool call in a channel, for troubleshooting
 *   GET    /api/channels/:id/summaries         Its summaries: scenes, the story so far, earlier in the scene, digest
 *   PUT    /api/channels/:id/summaries         Your own words for the story so far or a scene's summary
 *   POST   /api/channels/:id/summaries/update  Write the summaries that are due, now
 *   POST   /api/channels/:id/summaries/rebuild Rewrite all of them from the messages
 *   POST   /api/channels/:id/summaries/scenes/:sceneId/regenerate  Rewrite one scene's summary
 *   PUT    /api/channels/:id/cast/:entryId     Pin a notebook entry to a channel (add it to the cast)
 *   DELETE /api/channels/:id/cast/:entryId     Unpin it
 *
 *   PATCH  /api/messages/:id                   Edit a message's text (every version is kept)
 *   DELETE /api/messages/:id                   Delete one message (it's kept in history, as a tombstone)
 *   GET    /api/messages/:id/history           A message's versions, and the replies it replaced
 *   GET    /api/interventions                  The intervention log: what you've done that affects your kinwriter
 *   POST   /api/messages/:id/comments          Comment on a message (your kinwriter may reply)
 *   POST   /api/comments/:id/replies           Reply in a comment thread
 *   POST   /api/comments/:id/resolve           Resolve or reopen a thread
 *   DELETE /api/comments/:id                   Delete one of your comments
 *
 *   GET    /api/inbox                          What your kinwriter asks of you: asks and proposals (open, and recent)
 *   POST   /api/inbox/:id/:action              answer (with {answer}) or dismiss an ask; approve or deny a proposal
 *
 *   GET    /api/profiles                       Connection profiles and roulettes
 *   POST   /api/profiles                       Make a profile
 *   PATCH  /api/profiles/:id                   Change a profile
 *   DELETE /api/profiles/:id                   Delete a profile
 *   POST   /api/profiles/:id/test              Check whether its model can call tools
 *   POST   /api/roulettes                      Make a roulette
 *   PATCH  /api/roulettes/:id                  Change a roulette
 *   DELETE /api/roulettes/:id                  Delete a roulette
 *
 *   GET    /api/notebook                       Folders, entries and suggestions you can see, and field templates
 *   POST   /api/notebook/entries               Make an entry (a character or lore)
 *   PATCH  /api/notebook/entries/:id           Change an entry's contents (or suggest a change)
 *   PUT    /api/notebook/entries/:id/settings  Change its owner, visibility, editing or folder (owner only)
 *   DELETE /api/notebook/entries/:id           Delete an entry (or suggest deleting it)
 *   POST   /api/notebook/folders               Make a folder
 *   PATCH  /api/notebook/folders/:id           Rename a folder or change its settings
 *   DELETE /api/notebook/folders/:id           Delete a folder (its entries are kept)
 *   POST   /api/notebook/suggestions/:id/:action  accept, reject or withdraw a suggestion
 *
 * Every channel in a response comes with its `cast`: the entries pinned to
 * it, as you see them (see `ChannelView`). The notebook routes act as you
 * ("user"); your kinwriter acts through tools (src/tools.ts).
 *
 *   GET    /api/themes                         Every theme, for the theme picker
 *   POST   /api/themes                         Make a new theme, copying another
 *   GET    /api/themes/:id                     One theme's CSS and files, for the editor
 *   PATCH  /api/themes/:id                     Change one of your themes
 *   DELETE /api/themes/:id                     Delete one of your themes
 *   POST   /api/themes/:id/files               Add an image or font to one of your themes
 *   DELETE /api/themes/:id/files/:name         Remove one
 *
 * Theme files themselves are served at /themes/<id>/<file> (see src/themes.ts).
 *
 * Run it with `bun start`.
 */

import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { ApiError, CancelledError, listModels, type ApiOptions } from "./nanogpt.ts";
import { BusyError, Kinwriter, pickProfile, promptForChannel, testToolCalling, type TurnResult } from "./kinwriter.ts";
import { parseSceneBreak, postToMessages } from "./posts.ts";
import { Summarizer } from "./summarizer.ts";
import { Decider, testJev } from "./jev.ts";
import { FRESH_SCENE_MINUTES, inQuietHours, wakeContext, Wakeups } from "./wakeups.ts";
import { toolSpecs } from "./tools.ts";
import { healthReport } from "./health.ts";
import { developerView } from "./developer.ts";
import type { WakeContext, WakeReason } from "./prompt.ts";
import { Heartbeat } from "./heartbeat.ts";
import { describeSeeds, randomKinwriter, rollSeeds } from "./rng.ts";
import { keepAwake, Presence, TermuxNotifier, type Notifier } from "./notify.ts";
import { DEFAULT_THEME, ThemeLibrary } from "./themes.ts";
import { ENTRY_TEMPLATES } from "./notebook.ts";
import { rollCommand } from "./dice.ts";
import { applyRewrite } from "./rewrites.ts";
import { toolMap } from "./toolmap.ts";
import { wording } from "./wording.ts";
import { permissionViews, setGrant } from "./standing.ts";
import {
  advanceOrientation,
  madeInOrientation,
  addLibraryExample,
  nextCannedPost,
  orientationBingo,
  applyOrientationChoices,
  noteOnUser,
  proactivityPreference,
  PROACTIVITY_LEVELS,
  interviewCards,
  keepToYourself,
  handOver,
  prepareStep,
  waitingForYou,
  makeYourCharacter,
  orientationChannels,
  beginOrientation,
  currentStep,
  orientationStep,
  orientationSteps,
  declineOrientation,
  finishOrientation,
  orientationFeed,
  orientationRunning,
  orientationState as orientationStatus,
  skipOrientation,
  noteNewProfiles,
  orientationGuide,
  Rhythms,
} from "./orientation.ts";
import type { CastMember, Channel, Message, Settings } from "./types.ts";
import { PermissionError } from "./errors.ts";
import {
  isShared,
  SETUP_PENDING,
  NotFoundError,
  Store,
  ValidationError,
  validateChannelUpdate,
  validateNewChannel,
  validateSettings,
} from "./store.ts";

/** A channel as the app receives it: with its cast, as you see it. */
export type ChannelView = Channel & { cast: CastMember[] };

/** Settings that are about your kinwriter: changing one goes in the intervention log. */
const SETTINGS_THEY_SEE: Partial<Record<keyof Settings, string>> = {
  friendName: "your name",
  friendPrompt: "your identity (who you are)",
  literaryPrompt: "how you write in literary scenes",
  casualPrompt: "how you write in casual scenes",
  oocPrompt: "how you talk out of character",
  friendAvatar: "your avatar",
  friendColor: "your colour",
  oocBubbles: "whether you text in short bubbles out of character",
};

/** Longest message you can send, in characters. A generous guard against accidents. */
const MAX_MESSAGE_LENGTH = 100_000;

/**
 * An error that should be sent to the browser with a specific HTTP status.
 * Thrown by route handlers; turned into a JSON response by `fetch`.
 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The pieces a running app is made of, returned so tests can reach into them. */
export interface App {
  /** Handles one HTTP request. This is what `Bun.serve` calls. */
  fetch: (request: Request) => Promise<Response>;
  store: Store;
  kinwriter: Kinwriter;
  themes: ThemeLibrary;
  /** Writes summaries in the background (stage 7). */
  summarizer: Summarizer;
  /** Asks Jev, the small decision model (only `check` uses it). */
  decider: Decider;
  /** Checks the hard rules, and gives your kinwriter turns of their own. */
  wakeups: Wakeups;
  /** A timer that gives your kinwriter free moments (src/heartbeat.ts). */
  heartbeat: Heartbeat;
  /** Orientation and the weekly look back (src/orientation.ts). */
  rhythms: Rhythms;
  /** Their last turn before being archived: the note they wrote, or "". */
  farewell: () => Promise<string>;
  /** Whether the app is on screen, as it last said (for notifications). */
  presence: Presence;
  notifier: Notifier;
}

/**
 * One API route: a method, a path pattern, and what to do.
 *
 * In a pattern, `:id` matches one path segment, and its value arrives in
 * `params.id`. So `/api/channels/:id/turn` matches `/api/channels/abc/turn`
 * with `params.id === "abc"`.
 */
interface Route {
  method: string;
  pattern: string;
  handler: (request: Request, params: Record<string, string>) => Promise<Response> | Response;
}

/**
 * Check a request's method and path against a route.
 * Returns the `:name` values if it matches, or `null` if it doesn't.
 */
export function matchRoute(route: Pick<Route, "method" | "pattern">, method: string, path: string) {
  if (route.method !== method) return null;
  const want = route.pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(":")) {
      if (got[i] === "") return null;
      try {
        params[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
      } catch {
        return null; // badly encoded, like "%zz": treat as no match
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

/**
 * A fingerprint of the web app's files: it changes whenever any file in
 * `public/` changes.
 *
 * An installed app can stay open in the background for days. After you
 * update Kinaera and restart the server, that open page is still running the
 * old code. The page compares this fingerprint with the one it started with,
 * and reloads when they differ (see `checkForUpdate` in public/js/live.js).
 */
export function appVersion(publicDir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  // Sorted, so the same files always give the same fingerprint.
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: publicDir })].sort();
  for (const file of files) {
    hasher.update(file);
    hasher.update(readFileSync(join(publicDir, file)));
  }
  // The first 12 characters are plenty to tell versions apart.
  return hasher.digest("hex").slice(0, 12);
}

/**
 * Wire everything together: open the store, create the kinwriter, and build the
 * request handler. Nothing is listening yet; `main()` does that.
 */
/** The turns of their own a dry run can show. */
const DRY_RUN_WAKES: WakeReason[] = ["opened", "away", "scene-ended", "review", "heartbeat", "answer", "scheduled", "orientation", "lookback", "farewell", "aside"];

export function createApp(config: Config): App {
  const store = new Store(config.dataDir, { example: config.example ?? true });
  const api: ApiOptions = {
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
  };
  const kinwriter = new Kinwriter(store, api);
  // Who else is on their server (from the hub; names only), and group
  // channels and DMs (src/groups.ts).
  if (config.peers) kinwriter.peers = config.peers;
  if (config.groups) kinwriter.groups = config.groups;

  /** A DM you chose not to see: no screen, no messages. */
  function hiddenDm(channelId: string): boolean {
    const channel = store.hasChannel(channelId) ? store.getChannel(channelId) : null;
    // With kinwriters kept apart, every group channel and DM is out of sight.
    if (channel && isShared(channel) && store.hideShared()) return true;
    return channel?.kind === "dm" && config.groups?.info(channelId)?.visible === false;
  }
  const summarizer = new Summarizer(store, api, config.summaryDelayMs);
  const decider = new Decider(
    api,
    () => {
      const settings = store.getSettings();
      const [kind, id] = settings.decisionFallback.split(":");
      let fallback = null;
      try {
        fallback = kind === "profile" && id ? store.profiles.get(id) : null;
      } catch {
        fallback = null; // deleted since
      }
      return { decisionModel: settings.decisionModel, fallback };
    },
  );
  // Jev's only job: the check tool (src/check.ts).
  kinwriter.decider = decider;
  const wakeups = new Wakeups(store, kinwriter, Boolean(config.apiKey));
  const heartbeat = new Heartbeat(store, wakeups);
  const rhythms = new Rhythms(store, wakeups, undefined, () => kinwriter.decider);
  const presence = new Presence();
  const notifier = config.notifier ?? new TermuxNotifier(`http://127.0.0.1:${config.port}`);
  // A wake-up (or heartbeat) wrote to you while the app isn't on screen: a
  // phone notification (src/notify.ts).
  wakeups.onPosted = (channel, messages) => {
    if (presence.isVisible() || !notifier.available()) return;
    const text = messages.map((m) => m.content).join("\n");
    notifier.notify({ title: `${store.getSettings().friendName} in #${channel.name}`, text, channelId: channel.id, kinwriterId: config.kinwriterId });
  };
  // …and so does a post in another channel (post_in_channel), whatever
  // started the turn: you weren't looking there.
  // (Never for a DM: you're not in it, and it may be hidden from you.)
  kinwriter.onPostedElsewhere = (channel, messages) => {
    if (channel.kind !== "dm") wakeups.onPosted?.(channel, messages);
  };
  const autoWake = config.autoWake ?? true;
  // After their story post, a moment in OOC to say something as themselves, if they like.
  kinwriter.onStoryPosted = (channel) => {
    if (autoWake) void wakeups.event("aside", { channelId: channel.id });
  };

  /**
   * A scene you ended was just summarized: that's a wake-up (if it's the
   * newest scene break, and fresh, not an old one being rewritten).
   */
  summarizer.onSceneSummarized = (channelId, breakId) => {
    const sceneBreak = store.getMessage(breakId);
    const newest = store.getMessages(channelId).filter((m) => m.kind === "scene_break").at(-1);
    const fresh = Date.now() - new Date(sceneBreak.createdAt).getTime() < FRESH_SCENE_MINUTES * 60_000;
    if (autoWake && sceneBreak.author === "user" && newest?.id === breakId && fresh) {
      void wakeups.event("scene-ended", { channelId, breakId });
    }
  };

  /** You ended a scene: with summaries off, that's a wake-up straight away (otherwise, once it's summarized). */
  function sceneEnded(result: { sceneBreak: Message; channel: Channel }) {
    if (!store.getSettings().summaries && autoWake) {
      void wakeups.event("scene-ended", { channelId: result.channel.id, breakId: result.sceneBreak.id });
    }
    return result;
  }

  /** You made a suggestion for your kinwriter to review: that's a wake-up. */
  function maybeReview<T>(result: T): T {
    const suggestion = (result as { suggestion?: Parameters<typeof store.notebook.reviewerOf>[0] }).suggestion;
    if (autoWake && suggestion && store.notebook.reviewerOf(suggestion) === "friend") void wakeups.event("review");
    return result;
  }
  const version = appVersion(config.publicDir);
  const themes = new ThemeLibrary(
    config.themesDir,
    config.userThemesDir ?? join(config.dataDir, "themes"),
    readFileSync(join(config.publicDir, "style.css"), "utf8"),
  );

  /** Refuse a theme id that doesn't exist (for settings and channels). */
  function ensureTheme(id: string | null | undefined): void {
    if (id && !themes.exists(id)) throw new HttpError(400, "That theme doesn't exist.");
  }

  /** A channel, with its cast as you see it (hidden entries shown as "??? (hidden)"). */
  function channelView(channel: Channel): ChannelView {
    return { ...channel, cast: store.notebook.castFor("user", channel.id) };
  }

  function channelViews(): ChannelView[] {
    return store.listChannels().filter((c) => !hiddenDm(c.id)).map(channelView);
  }

  /** Presence, from the real state: writing, reading (a tool call), quiet (quiet hours), or idle. */
  function presenceNow(): "writing" | "reading" | "quiet" | "idle" {
    const phases = Object.values(kinwriter.phases());
    if (phases.includes("reading")) return "reading";
    if (phases.length > 0) return "writing";
    const settings = store.getSettings();
    return inQuietHours(new Date(), settings.quietStart, settings.quietEnd) ? "quiet" : "idle";
  }

  /** The status your kinwriter set themselves (set_status), or null. */
  function statusNow(): { text: string; at: string } | null {
    const value = store.appState.get("status");
    return value ? (JSON.parse(value) as { text: string; at: string }) : null;
  }

  /** A channel's voice marks and "not me" flags, by message id. */
  function channelFlags(channelId: string) {
    const ids = new Set(store.getMessages(channelId).map((m) => m.id));
    const marks = [...store.continuity.voiceMarks()].filter((id) => ids.has(id));
    const notMe = Object.fromEntries(
      [...store.continuity.notMe()].filter(([id]) => ids.has(id)).map(([id, f]) => [id, { note: f.note, profile: f.profile }]),
    );
    return { voice: marks, notMe };
  }

  /** The practice channel, with the sample notes pinned to it. */
  function practiceView(): ChannelView | null {
    const channel = store.practiceChannel();
    return channel ? channelView(channel) : null;
  }

  /** Your suggestions for their identity and self-page that your kinwriter hasn't answered yet. */
  function waitingOnKinwriter() {
    return {
      identity: store.identity.pending(),
      selfNotes: store.selfPage.pendingNotes().filter((n) => n.source === "user"),
    };
  }

  /** Everything on the kinwriter page (the journal only as counts: it's private). */
  function kinwriterPage() {
    return {
      identity: store.identity.current(),
      history: store.identity.history(),
      selfPage: store.selfPage.view(),
      journal: store.journal.counts(),
      // Drafts are private too: only how many.
      drafts: store.drafts.count(),
      // Wake-ups they set for themselves: when, not what for (their notes are theirs).
      upcoming: store.schedule.waiting().map((w) => w.at),
      nextHeartbeat: heartbeat.nextAt()?.toISOString() ?? null,
      // The weekly wellbeing reading (src/wellbeing.ts): shown here and in their look back only.
      wellbeing: store.wellbeing.recent(8),
      // Their notes on each profile (src/continuity.ts).
      profileNotes: (() => {
        const notes = store.continuity.profileNotes();
        return store.profiles.list().flatMap((p) => (notes.has(p.id) ? [{ profile: p.name, note: notes.get(p.id)!.note }] : []));
      })(),
      voiceMarks: store.continuity.voiceMarks().size,
      orientation: orientationState(),
      // Their tool map: "I'd reach for this when…", one line per tool (src/toolmap.ts).
      toolMap: Object.entries(toolMap(store)).map(([tool, entry]) => ({ tool, when: entry.when })),
      // How proactive they'd like to be, beside your chattiness (the ceiling).
      proactivity: { preference: proactivityPreference(store), chattiness: store.getSettings().wakeups },
      // Their note on you is private: only whether there is one.
      noteOnYou: noteOnUser(store) !== null,
      waiting: waitingOnKinwriter(),
      permissions: permissionViews(store),
    };
  }

  /** In the interview, how many messages each of you has written in #practice since it began. */
  function interviewCounts(): { yours: number; theirs: number } {
    const session = orientationRunning(store);
    if (!session?.stepAt) return { yours: 0, theirs: 0 };
    const since = store.getMessages(session.channelId).filter((m) => m.createdAt >= session.stepAt!);
    return { yours: since.filter((m) => m.author === "user").length, theirs: since.filter((m) => m.author !== "user").length };
  }

  /** The nudge toward wrapping up, once you've each asked a handful (defaults/interview.md). */
  function interviewWrapUp(): string | null {
    const words = wording("interview");
    const after = Number(words["wrap-up-after"] ?? 5) || 5;
    const { yours, theirs } = interviewCounts();
    return Math.min(yours, theirs) >= after ? (words["wrap-up"] ?? null) : null;
  }

  /**
   * Where orientation stands, for their page and the app: never had one,
   * asked for one, skipped, running (and how), or done; and how the last
   * one went.
   */
  function orientationState() {
    const state = orientationStatus(store);
    const practice = store.practiceChannel();
    const last = store.wakeLog.recent(300).find((w) => w.reason === "orientation") ?? null;
    // The step it's on, as your card shows it (src/orientation.ts).
    const step = state.session ? currentStep(state.session) : null;
    // Characters and secrets made so far (their secrets only as a count).
    const made = state.session ? madeInOrientation(store) : null;
    return {
      ...state,
      step: step && state.session ? { ...step, index: state.session.step, count: state.session.steps.length, waiting: waitingForYou(state.session) } : null,
      made,
      // The interview: the cards for you, and how many times you've each written.
      // Your choices: what was made, and their preference (they don't see this).
      choices: step?.id === "choices" && state.session
        ? {
            version: state.session.version,
            sceneName: state.session.scene && store.hasChannel(state.session.scene) ? store.getChannel(state.session.scene).name : null,
            questions: state.session.questions?.length ?? 0,
            preference: proactivityPreference(store)?.level ?? null,
            chattiness: store.getSettings().wakeups,
          }
        : null,
      // On their own: tool bingo, filled from the feed.
      bingo:
        state.session?.version === "returning" && practice
          ? orientationBingo(store, toolSpecs({ store, channel: practice, mode: "post", api }).map((t) => t.function.name))
          : null,
      interview: step?.id === "interview" ? { cards: interviewCards().forKinwriter, ...interviewCounts(), wrapUp: interviewWrapUp() } : null,
      writing: practice ? kinwriter.isBusy(practice.id) : false,
      practiceId: practice?.id ?? null,
      last: last ? { at: last.at, outcome: last.outcome, detail: last.detail } : null,
    };
  }

  /**
   * One turn of an orientation, at once: no hard rules, no timer. It
   * carries the current step's part for them as "Why you're up"
   * (`followup`: the step's second turn, after a first that wrote).
   */
  async function orientationTurn(followup = false): Promise<TurnResult | null> {
    const session = orientationRunning(store);
    if (!session) return null;
    const step = currentStep(session);
    // Most steps happen in #practice; the starter scene's, in its story channel.
    const channel = store.getChannel(step?.where === "scene" && session.scene ? session.scene : session.channelId);
    const tools = toolSpecs({ store, channel, mode: "post", api }).map((t) => t.function.name);
    const wake: WakeContext = { reason: "orientation", sinceUser: null, waiting: [], orientation: orientationGuide(tools, session, followup, store) };
    try {
      const result = await kinwriter.takeTurn(channel.id, "wake", { wake });
      const wrote = result.messages.length > 0;
      store.wakeLog.add({ at: new Date().toISOString(), reason: "orientation", outcome: wrote ? "posted" : "quiet", channelId: channel.id, detail: `${session.version === "full" ? "Together" : "On their own"}, ${step?.title ?? "a step"}: ${wrote ? "they wrote in their practice channel." : "they tried things and didn't write."}` });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.wakeLog.add({ at: new Date().toISOString(), reason: "orientation", outcome: "failed", channelId: channel.id, detail: message });
      console.warn(`[orientation] a turn failed: ${message}`);
      return null;
    }
  }

  /** A step begins: their part, if it has one (and its follow-up, if they wrote). */
  async function enterStep(): Promise<void> {
    // The starter scene's channel, made as its step begins with both characters; on their own, the library example.
    prepareStep(store);
    const session = orientationRunning(store);
    const step = session ? currentStep(session) : null;
    if (!session || !step?.kinwriter.trim()) return;
    // A step you try first: their turn waits until you hand it over.
    if (waitingForYou(session)) return;
    // A step that starts with you writing (the interview): no turn of its own.
    if (session.version === "full" && step.after === "message") return;
    const first = await orientationTurn();
    if (first && first.messages.length > 0 && step.followup.trim() && orientationRunning(store)) {
      // On their own, in the practice scene: the canned partner answers first.
      if (step.where === "scene") nextCannedPost(store);
      await orientationTurn(true);
    }
  }

  /** You hand them the step you tried first: their part, now. */
  async function handedOver(): Promise<void> {
    const session = orientationRunning(store);
    const step = session ? currentStep(session) : null;
    if (!session || !step?.kinwriter.trim()) return;
    const first = await orientationTurn();
    if (first && first.messages.length > 0 && step.followup.trim() && orientationRunning(store)) await orientationTurn(true);
  }

  /**
   * Run an orientation you picked. Together, the first step begins now,
   * and you move on with Next. On their own, their parts run back to back,
   * step after step, then wait for your choices.
   */
  async function runOrientation(): Promise<void> {
    const session = orientationRunning(store);
    if (!session) return;
    console.log(`[orientation] started (${session.version === "full" ? "together" : "on their own"})`);
    await enterStep();
    if (session.version === "returning") {
      while (orientationRunning(store)) {
        const step = advanceOrientation(store);
        if (!step) break;
        // Their part is done; your choices end it.
        if (step.id === "choices") {
          console.log("[orientation] on their own: done, waiting for your choices");
          return;
        }
        await enterStep();
      }
      finishOrientation(store);
      console.log("[orientation] finished (on their own)");
    }
  }

  /** While an orientation runs, their other channels wait (src/orientation.ts). */
  function ensureNotOrienting(channelId: string): void {
    const session = orientationRunning(store);
    if (session && !orientationChannels(session).includes(channelId)) {
      throw new HttpError(409, `${store.getSettings().friendName} is in an orientation. Their other channels open again when it's done.`);
    }
  }

  /** You suggested something for your kinwriter to answer: they answer now (or as soon as they're free). */
  function suggested(): void {
    if (autoWake) wakeups.requestReview();
  }

  function sceneBreakResult(result: { sceneBreak: Message; channel: Channel }) {
    return { sceneBreak: result.sceneBreak, channel: channelView(result.channel) };
  }

  /**
   * After you comment, your kinwriter gets a turn to reply in the thread. On
   * your own message, the comment may be a note for yourself: they can
   * leave it (their call, not a rule's). The reply is reported as data: if
   * it fails, your comment is still saved.
   */
  async function commentReply(threadId: string) {
    const reply = await tryTurn(() => kinwriter.replyToComment(threadId));
    return { thread: store.comments.thread(threadId), ...reply };
  }

  /**
   * The notebook entries to attach to a message you're sending: the ids you
   * picked (`attach`), plus any entry you linked in the text with
   * `[[Name]]`. You must be able to see each, and so must your kinwriter, or
   * it couldn't be sent.
   */
  function readAttachments(body: unknown, content: string): string[] {
    const picked = (body as { attach?: unknown } | null)?.attach ?? [];
    if (!Array.isArray(picked) || !picked.every((id) => typeof id === "string")) {
      throw new HttpError(400, '"attach" must be a list of notebook entry ids.');
    }
    const ids = new Set<string>();
    for (const id of picked) {
      const entry = store.notebook.getEntry("user", id); // 404 if you can't see it
      if (!store.notebook.canSeeEntry("friend", id)) {
        throw new HttpError(400, `${entry.name} is hidden from your kinwriter, so it can't be sent to them.`);
      }
      ids.add(id);
    }
    // [[Name]] and [[Name|shown text]] links, silently skipping names that
    // aren't in the notebook or that your kinwriter can't see.
    const entries = store.notebook.listEntries("user");
    for (const [, name] of content.matchAll(/\[\[([^\]|\n]{1,100})(?:\|[^\]\n]*)?\]\]/g)) {
      const entry = entries.find((e) => e.name.toLowerCase() === name!.trim().toLowerCase());
      if (entry && store.notebook.canSeeEntry("friend", entry.id)) ids.add(entry.id);
    }
    return [...ids];
  }

  /**
   * Changes to who your kinwriter is, or how they write, go in the
   * intervention log, one line each.
   */
  function noteSettingsChanges(before: Settings, after: Settings): void {
    for (const [key, what] of Object.entries(SETTINGS_THEY_SEE) as [keyof Settings, string][]) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        store.interventions.add({ kind: "settings", summary: `The user changed ${what}.` });
      }
    }
  }

  /** Refuse to change a channel's messages while the kinwriter is writing there. */
  function ensureIdle(channelId: string): void {
    if (kinwriter.isBusy(channelId)) throw new BusyError();
  }

  // Routes are checked in order and the first match wins, so fixed paths
  // (`/api/channels/order`) must come before patterns that would also match
  // them (`/api/channels/:id`).
  const routes: Route[] = [
    // ------------------------------------------------------- server-wide
    {
      method: "GET",
      pattern: "/api/state",
      handler: () =>
        json({
          settings: store.getSettings(),
          channels: channelViews(),
          // Your kinwriter's own practice channel, shown apart (src/orientation.ts).
          practice: practiceView(),
          categories: store.listCategories(),
          profiles: store.profiles.list(),
          roulettes: store.profiles.listRoulettes(),
          inbox: store.inbox.open(),
          // Your suggestions still waiting for your kinwriter.
          waiting: waitingOnKinwriter(),
          // After a fresh start: make your new kinwriter first (POST /api/setup).
          setup: store.appState.get(SETUP_PENDING) !== null,
          // Orientation: where it stands (the app offers it, shows it running, or not).
          orientation: orientationState(),
          developerPanel: config.developerPanel === true,
          busyChannels: kinwriter.busyChannels(),
          // Presence: writing or reading in each busy channel, and overall
          // (with quiet hours), plus the status they set themselves.
          phases: kinwriter.phases(),
          presence: presenceNow(),
          status: statusNow(),
          appVersion: version,
          emojis: store.reactions.listEmojis(),
          // Whether phone notifications work here (Termux), and the next heartbeat.
          notifications: notifier.available(),
          heartbeatNext: heartbeat.nextAt()?.toISOString() ?? null,
          // For noticing messages the app didn't ask for (a wake-up): a
          // number that changes with any message, and each channel's newest.
          revision: store.revision,
          activity: Object.fromEntries(
            [...store.listChannels(), ...(store.practiceChannel() ? [store.practiceChannel()!] : [])].map((c) => {
              const last = store.lastMessage(c.id);
              return [c.id, last ? { lastId: last.id, author: last.author, at: last.createdAt } : null];
            }),
          ),
        }),
    },
    {
      // You opened the app (or came back to it). Your kinwriter may wake up;
      // the answer doesn't wait for that (the app notices new messages).
      method: "POST",
      pattern: "/api/wake",
      handler: async (request) => {
        const body = (await readJson(request)) as { event?: unknown } | null;
        if (body?.event !== "opened") throw new HttpError(400, '"event" must be "opened".');
        if (autoWake) void wakeups.event("opened");
        return json({ ok: true });
      },
    },
    // The reference library: long texts your kinwriter can search.
    {
      method: "GET",
      pattern: "/api/library",
      handler: () => json({ documents: store.library.list() }),
    },
    {
      method: "POST",
      pattern: "/api/library",
      handler: async (request) => json({ document: store.library.add(await readObject(request)) }),
    },
    {
      method: "GET",
      pattern: "/api/library/search",
      handler: (request) => {
        const params = new URL(request.url).searchParams;
        const doc = params.get("doc");
        return json({ results: store.library.search(params.get("q") ?? "", doc ? [store.library.get(doc).id] : undefined, 20) });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/library/:id",
      handler: async (request, { id }) => json({ document: store.library.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/library/:id",
      handler: (_request, { id }) => {
        store.library.remove(id!);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/library/:id/passages/:seq",
      handler: (request, { id, seq }) => {
        const count = Number(new URL(request.url).searchParams.get("count") ?? 1);
        const from = Number(seq);
        if (!Number.isInteger(from) || !Number.isInteger(count)) throw new HttpError(400, "Passage numbers are whole numbers.");
        return json({ document: store.library.get(id!), passages: store.library.passages(id!, from, Math.min(10, Math.max(1, count))) });
      },
    },
    {
      // Settings → "Surprise me": a new kinwriter from random ingredients (not saved).
      method: "POST",
      pattern: "/api/friend/random",
      handler: async () => {
        if (!config.apiKey) throw new HttpError(400, "Add your nanoGPT API key first.");
        const seeds = rollSeeds();
        const ooc = store.listChannels().find((c) => c.kind === "ooc") ?? store.listChannels()[0]!;
        try {
          const made = await randomKinwriter(api, pickProfile(store, ooc), seeds);
          return json({ ...made, seeds: describeSeeds(seeds) });
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new HttpError(502, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      // The app is (or isn't) on screen: no notifications while it is.
      method: "POST",
      pattern: "/api/presence",
      handler: async (request) => {
        const body = await readObject(request);
        presence.set(body.visible === true);
        return json({ ok: true });
      },
    },
    {
      // Settings → "Beat now": a heartbeat straight away, whatever the time.
      method: "POST",
      pattern: "/api/heartbeat",
      handler: async () => json({ beat: await heartbeat.tick(true) }),
    },
    {
      method: "GET",
      pattern: "/api/wakeups",
      handler: () => json({ wakeups: store.wakeLog.recent() }),
    },
    {
      // Ask Jev one tiny question, to see if it's reachable and understood.
      method: "POST",
      pattern: "/api/jev/test",
      handler: async () => json(await testJev(decider)),
    },
    {
      method: "GET",
      pattern: "/api/checks",
      handler: () => json({ checks: store.checkLog.recent(200) }),
    },
    {
      method: "PUT",
      pattern: "/api/settings",
      handler: async (request) => {
        const update = validateSettings(await readJson(request));
        ensureTheme(update.appTheme);
        // Their identity is theirs (src/identity.ts): a change you make to it
        // is a suggestion they accept or decline, never saved over it.
        let suggestion = null;
        if (update.friendPrompt !== undefined) {
          const current = store.identity.current();
          if (update.friendPrompt.trim() !== (current?.identity ?? "")) {
            suggestion = store.identity.suggest({ identity: update.friendPrompt });
            store.interventions.add({ kind: "settings", summary: "The user suggested a change to your identity." });
          }
          delete update.friendPrompt;
        }
        for (const assignment of [update.rpAssignment, update.oocAssignment, update.summaryAssignment, update.decisionFallback]) {
          if (assignment) store.profiles.checkAssignment(assignment);
        }
        const before = store.getSettings();
        const settings = store.updateSettings(update);
        noteSettingsChanges(before, settings);
        // Turning summaries on, or changing when they're written: catch up.
        if (update.summaries || update.summaryEvery || update.historyLimit) summarizer.scheduleAll();
        // The heartbeat's pace changed: start counting again from now.
        if (update.heartbeatHours !== undefined) {
          heartbeat.reset();
          if (update.heartbeatHours > 0) keepAwake();
        }
        if (suggestion) suggested();
        return json({ settings, suggestion });
      },
    },
    {
      method: "GET",
      pattern: "/api/models",
      handler: async () => json({ models: await listModels(api) }),
    },

    // ---------------------------------------------------------- channels
    {
      method: "POST",
      pattern: "/api/channels",
      handler: async (request) => {
        const body = await readJson(request);
        const categoryId = (body as { categoryId?: unknown } | null)?.categoryId;
        if (categoryId !== undefined && categoryId !== null && typeof categoryId !== "string") {
          throw new HttpError(400, '"categoryId" must be a category id.');
        }
        return json({ channel: channelView(store.createChannel({ ...validateNewChannel(body), categoryId: categoryId || null })) });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/order",
      handler: async (request) => {
        // A drag in the sidebar: the new order, and (optionally) which
        // category each moved channel is now in: {channelId: categoryId | null}.
        const body = (await readJson(request)) as { ids?: unknown; categories?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of channel ids.');
        }
        const categories = body.categories ?? {};
        if (
          typeof categories !== "object" ||
          categories === null ||
          Array.isArray(categories) ||
          !Object.values(categories).every((c) => c === null || typeof c === "string")
        ) {
          throw new HttpError(400, '"categories" must map channel ids to category ids (or null).');
        }
        store.reorderChannels(body.ids, categories as Record<string, string | null>);
        return json({ channels: channelViews() });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/channels/:id",
      handler: async (request, { id }) => {
        const update = validateChannelUpdate(await readJson(request));
        ensureTheme(update.theme);
        if (update.assignment) store.profiles.checkAssignment(update.assignment);
        return json({ channel: channelView(store.updateChannel(id!, update)) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id",
      handler: (_request, { id }) => {
        // A turn in progress would try to save its reply into a channel that
        // no longer exists, so wait for it to finish.
        ensureIdle(id!);
        store.deleteChannel(id!);
        return json({ ok: true });
      },
    },

    // ------------------------------------------------ channel messages
    {
      method: "GET",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => {
        if (hiddenDm(id!)) throw new HttpError(403, "You chose not to see this DM.");
        return json({
          messages: store.getMessages(id!),
          // Your kinwriter's actions (shown under their messages), and comments.
          toolCalls: store.toolLog.forChannel(id!),
          threads: store.comments.forChannel(id!),
          // Rewrites you suggested for parts of their messages (src/rewrites.ts).
          rewrites: store.rewrites.forChannel(id!),
          // Scene summaries (shown under scene breaks), the story so far, and more.
          summaries: summarizer.view(id!),
          // Posts your kinwriter marked as sounding like them, or flagged "not me" (src/continuity.ts).
          flags: channelFlags(id!),
        });
      },
    },

    // --------------------------------------------------------- summaries
    {
      method: "GET",
      pattern: "/api/channels/:id/summaries",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // Your own words for the story so far, or a scene's summary. Empty
      // text removes yours, and the model writes one again.
      method: "PUT",
      pattern: "/api/channels/:id/summaries",
      handler: async (request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        const body = (await readJson(request)) as { kind?: unknown; sceneId?: unknown; content?: unknown } | null;
        const content = body?.content;
        if (typeof content !== "string" || content.length > 20_000) {
          throw new HttpError(400, '"content" must be text of 20,000 characters at most.');
        }
        let throughSeq: number;
        let sceneId = "";
        if (body?.kind === "story") {
          throughSeq = store.summaries.get(id!, "story")?.throughSeq ?? 0;
        } else if (body?.kind === "scene") {
          const breakMessage = typeof body.sceneId === "string" ? store.getMessage(body.sceneId) : null;
          if (!breakMessage || breakMessage.kind !== "scene_break" || breakMessage.channelId !== id) {
            throw new HttpError(400, '"sceneId" must be a scene break in this channel.');
          }
          sceneId = breakMessage.id;
          throughSeq = store.summaries.withSeq(id!, [breakMessage])[0]!.seq;
          // The story so far is rewritten with the new scene summary.
          store.summaries.markStale(id!, "story");
        } else {
          throw new HttpError(400, '"kind" must be "story" or "scene".');
        }
        if (content.trim() === "") store.summaries.remove(id!, body.kind, sceneId);
        else store.summaries.edit(id!, body.kind, sceneId, content.trim(), throughSeq);
        summarizer.schedule(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // "Update now": write whatever summaries are due, and wait for them.
      method: "POST",
      pattern: "/api/channels/:id/summaries/update",
      handler: async (_request, { id }) => {
        store.getChannel(id!);
        await summarizer.catchUp(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // "Rebuild": rewrite every summary from the messages, your edits included.
      method: "POST",
      pattern: "/api/channels/:id/summaries/rebuild",
      handler: async (_request, { id }) => {
        store.getChannel(id!);
        await summarizer.rebuild(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      // Rewrite one scene's summary (your edit to it included).
      method: "POST",
      pattern: "/api/channels/:id/summaries/scenes/:sceneId/regenerate",
      handler: async (_request, { id, sceneId }) => {
        store.getChannel(id!);
        store.summaries.remove(id!, "scene", sceneId!);
        store.summaries.markStale(id!, "story");
        await summarizer.catchUp(id!);
        return json({ summaries: summarizer.view(id!) });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/tool-log",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        return json({ toolCalls: store.toolLog.forChannel(id!, 1000) });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/messages",
      handler: async (request, { id }) => {
        const body = await readJson(request);
        // `/roll 2d6+3`: the roll itself is saved, so it can't be made up (src/dice.ts).
        const content = rollCommand(requireText(body, "content"));
        const channel = store.getChannel(id!); // 404 for an unknown channel
        // #practice is theirs: you write there only in an orientation you're doing together.
        if (channel.kind === "practice" && orientationRunning(store)?.version !== "full") {
          throw new HttpError(400, "The practice channel is your kinwriter's own: you can read it, not write in it.");
        }
        ensureNotOrienting(channel.id);
        if (channel.kind === "dm") throw new HttpError(400, "A DM is between two kinwriters: you can't write in it.");
        // Refuse *before* saving, so a message sent while the kinwriter is busy
        // isn't saved without a reply attached.
        ensureIdle(id!);

        // `=====` (with an optional title) in an RP channel is a scene break,
        // not a post, and the kinwriter doesn't reply to it.
        const sceneTitle = channel.kind === "rp" ? parseSceneBreak(content) : null;
        if (sceneTitle !== null) return json(sceneBreakResult(sceneEnded(store.addSceneBreak(id!, "user", sceneTitle))));

        const yourCharacters = store.notebook.postableCharacters();
        const postingAs = readPostingAs(body, yourCharacters);
        const messages = postToMessages(channel, content, yourCharacters, postingAs);
        if (messages.length === 0) throw new HttpError(400, "There's nothing to send after the character tags.");
        // A reply (Discord-style) to a message in this channel.
        const replyTo = (body as { replyTo?: unknown }).replyTo;
        if (replyTo !== undefined && replyTo !== null) {
          if (typeof replyTo !== "string" || store.getLiveMessage(replyTo).channelId !== id) throw new HttpError(400, '"replyTo" must be a message in this channel.');
          messages[0] = { ...messages[0]!, replyTo };
        }
        // Notes you attached (and entries you [[linked]]) go with the message.
        const attach = readAttachments(body, content);
        const userMessages = store.addTurn(messages);
        if (attach.length > 0) userMessages[0] = store.attach(userMessages[0]!.id, attach);

        // Posting as one of your characters puts them in the channel's cast,
        // if they aren't already.
        for (const name of new Set(userMessages.flatMap((m) => m.characters))) {
          const entry = yourCharacters.find((c) => c.name === name);
          if (entry) store.notebook.pin("user", id!, entry.id);
        }

        // `reply: false`: just save it. In OOC with texting on, the app sends
        // your bubbles this way and asks for a turn once you pause. In a group
        // channel, the hub starts a round (src/groups.ts): nobody replies here.
        if ((body as { reply?: unknown }).reply === false || channel.kind === "group") {
          return json({ userMessages, channel: channelView(store.getChannel(id!)), channels: channelViews() });
        }
        // The reply is attempted separately: if it fails, your message is still
        // saved and the app offers to retry with a kinwriter turn.
        const reply = await tryTurn(() => kinwriter.takeTurn(id!, "user-message"));
        return json({ userMessages, ...reply, channel: channelView(store.getChannel(id!)), channels: channelViews() });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/messages",
      handler: (_request, { id }) => {
        ensureIdle(id!);
        store.clearMessages(id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/turn",
      handler: async (_request, { id }) => {
        if (store.getChannel(id!).kind === "dm") throw new HttpError(400, "A DM is between two kinwriters: they write there on their own time.");
        ensureNotOrienting(id!);
        return json({ ...turnResult(await kinwriter.takeTurn(id!, "continue")), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/scene-breaks",
      handler: async (request, { id }) => {
        const body = (await readJson(request)) as { title?: unknown } | null;
        const title = body?.title ?? "";
        if (typeof title !== "string" || title.length > 200) {
          throw new HttpError(400, '"title" must be text of 200 characters at most.');
        }
        // Waits for a turn in progress, so the break can't land in the middle
        // of a reply.
        ensureIdle(id!);
        return json(sceneBreakResult(sceneEnded(store.addSceneBreak(id!, "user", title))));
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/regenerate",
      handler: async (request, { id }) => {
        ensureIdle(id!);
        ensureNotOrienting(id!);
        if (isShared(store.getChannel(id!))) throw new HttpError(400, "Replies in a group channel or DM can't be regenerated: the others have already seen them.");
        // Optional: the profile to write with ("Regenerate with..."). Without
        // one, the channel's profile or roulette picks again.
        const body = (await readJson(request)) as { profileId?: unknown } | null;
        const profileId = typeof body?.profileId === "string" && body.profileId ? body.profileId : undefined;
        if (profileId) store.profiles.get(profileId); // 404 for an unknown profile
        // The whole last reply: one post, or every bubble of a casual reply.
        const replacedIds = store.lastKinwriterTurn(id!).map((m) => m.id);
        if (replacedIds.length === 0) {
          throw new HttpError(400, "The last message isn't from your kinwriter, so there's nothing to regenerate.");
        }
        // Generate first, and only delete the old reply once the new one exists.
        // If generation fails you keep the reply you had.
        const result = await kinwriter.takeTurn(id!, "regenerate", { replacing: replacedIds, profileId });
        // If the new turn wrote nothing, the old reply stays.
        if (result.replaced.length > 0) {
          const how = profileId ? ` with ${store.profiles.get(profileId).name}` : "";
          store.interventions.add({
            kind: "regenerate",
            summary: `The user regenerated your reply in #${store.getChannel(id!).name}${how}. The earlier one is kept as an alternate.`,
            channelId: id!,
            messageId: result.messages[0]?.id ?? null,
          });
        }
        return json({ ...turnResult(result), replacedIds: result.replaced, channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/channels/:id/cancel",
      handler: (_request, { id }) => {
        store.getChannel(id!); // 404 for an unknown channel
        // `cancelled` is false if nothing was running, e.g. the reply
        // arrived just before you pressed Stop.
        return json({ cancelled: kinwriter.cancel(id!) });
      },
    },
    {
      method: "GET",
      pattern: "/api/channels/:id/prompt",
      handler: (request, { id }) => {
        // For a roulette, the model notes depend on the profile picked, so
        // the preview shows a given profile (`?profile=<id>`), or the one a
        // roulette would pick first.
        const profileId = new URL(request.url).searchParams.get("profile");
        const profile = profileId ? store.profiles.get(profileId) : pickProfile(store, store.getChannel(id!), 0);
        // The preview never shows journal text (it's private to your kinwriter).
        return json({ messages: promptForChannel(store, id!, { profile, preview: true, peers: kinwriter.peers() }), profile });
      },
    },

    {
      // The health view (src/health.ts): shape, never content.
      method: "GET",
      pattern: "/api/health",
      handler: () => json(healthReport(store)),
    },
    {
      // The developer panel (src/developer.ts): hidden unless DEVELOPER_PANEL=1.
      // Deliberately not logged: the kinwriter's prompt says openings aren't.
      method: "GET",
      pattern: "/api/developer",
      handler: () => {
        if (!config.developerPanel) throw new HttpError(404, "Not found.");
        return json(developerView(store, config.groups));
      },
    },
    {
      // A dry run (Settings → Prompts): any kind of turn's prompt, built
      // as that turn would build it, and with `send`, the model's reply.
      // Nothing is saved, and no tool runs (see Kinwriter.dryRun).
      method: "POST",
      pattern: "/api/dry-run",
      handler: async (request) => {
        const body = (await readJson(request)) as Record<string, unknown>;
        const turn = typeof body.turn === "string" ? body.turn : "turn";
        if (turn !== "turn" && !DRY_RUN_WAKES.includes(turn as WakeReason)) throw new HttpError(400, `There's no kind of turn called "${turn}".`);
        const reason = turn === "turn" ? null : (turn as WakeReason);
        // Turns of their own happen in the practice channel; the rest where you say.
        const own = reason === "orientation" || reason === "lookback";
        const channelId = own ? store.ensurePractice().id : typeof body.channelId === "string" ? body.channelId : "";
        const channel = store.getChannel(channelId); // 404 for an unknown channel
        if (hiddenDm(channel.id)) throw new HttpError(403, "You chose not to see this DM.");
        const profileId = typeof body.profileId === "string" && body.profileId ? body.profileId : undefined;
        let wake: WakeContext | undefined;
        let displayWake: WakeContext | undefined;
        if (reason) {
          const posts = store.listChannels().flatMap((c) => store.getMessages(c.id)).filter((m) => m.kind === "post" && m.author === "user");
          const yourLast = posts.map((m) => m.createdAt).sort().at(-1);
          const scheduled = reason === "scheduled" ? store.schedule.waiting()[0] : undefined;
          const lastBreak = reason === "scene-ended" ? store.getMessages(channel.id).filter((m) => m.kind === "scene_break").at(-1) : undefined;
          // An aside is about the story your kinwriter posted in most recently.
          const story =
            reason === "aside"
              ? store
                  .listChannels()
                  .filter((c) => c.kind === "rp")
                  .map((c) => ({ c, at: store.getMessages(c.id).filter((m) => m.author === "friend").at(-1)?.createdAt ?? "" }))
                  .sort((a, b) => b.at.localeCompare(a.at))[0]?.c
              : undefined;
          if (reason === "aside" && !story) throw new HttpError(400, "There's no story channel for an aside to be about yet.");
          wake = wakeContext(store, reason, yourLast ? Date.now() - new Date(yourLast).getTime() : null, {
            scheduleId: scheduled?.id,
            channelId: story?.id ?? (lastBreak ? channel.id : undefined),
            breakId: lastBreak?.id,
          });
          // With none set, a sample note shows how a scheduled wake-up reads.
          if (reason === "scheduled" && !wake.scheduled) {
            const now = new Date().toISOString();
            wake.scheduled = { note: "(a sample note: you have no wake-ups set)", setAt: now, dueAt: now };
          }
          if (reason === "orientation") {
            const tools = toolSpecs({ store, channel, mode: "post", api }).map((t) => t.function.name);
            // The first step of the together version with a part for them.
            const steps = orientationSteps("full");
            const first = Math.max(0, steps.findIndex((id) => orientationStep(id).kinwriter.trim()));
            wake.orientation = orientationGuide(tools, { version: "full", steps, step: first });
          }
          // The look back carries their journal: private, so not on screen.
          displayWake = wake.lookback
            ? { ...wake, lookback: wake.lookback.map((e) => ({ ...e, content: "(private: the journal isn't shown in the app)" })) }
            : wake;
        }
        try {
          return json(await kinwriter.dryRun(channel.id, { wake, displayWake, profileId, send: body.send === true }));
        } catch (error) {
          if (error instanceof ApiError) throw new HttpError(502, error.message);
          throw error;
        }
      },
    },

    // ---------------------------------------------------------- messages
    {
      method: "PATCH",
      pattern: "/api/messages/:id",
      handler: async (request, { id }) => {
        const body = await readJson(request);
        // A scene break's "content" is its title, which may be empty.
        if (store.getLiveMessage(id!).kind === "scene_break") {
          const title = (body as { content?: unknown } | null)?.content;
          if (typeof title !== "string" || title.length > 200) {
            throw new HttpError(400, '"content" must be text of 200 characters at most.');
          }
          return json({ message: store.editMessage(id!, title.trim()) });
        }
        return json({ message: store.editMessage(id!, requireText(body, "content")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/messages/:id",
      handler: (_request, { id }) => {
        ensureIdle(store.getLiveMessage(id!).channelId);
        store.deleteMessage(id!);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/messages/:id/history",
      handler: (_request, { id }) => json(store.history(id!)),
    },
    {
      method: "GET",
      pattern: "/api/interventions",
      handler: () => json({ interventions: store.interventions.recent(100) }),
    },

    // -------------------------------------------------------- categories
    {
      method: "POST",
      pattern: "/api/categories",
      handler: async (request) => json({ category: store.createCategory(await readJson(request)), categories: store.listCategories() }),
    },
    {
      method: "PUT",
      pattern: "/api/categories/order",
      handler: async (request) => {
        const body = (await readJson(request)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
          throw new HttpError(400, '"ids" must be a list of category ids.');
        }
        return json({ categories: store.reorderCategories(body.ids) });
      },
    },
    {
      method: "PATCH",
      pattern: "/api/categories/:id",
      handler: async (request, { id }) => json({ category: store.updateCategory(id!, await readJson(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/categories/:id",
      handler: (_request, { id }) => {
        store.deleteCategory(id!);
        return json({ categories: store.listCategories(), channels: channelViews() });
      },
    },

    // --------------------------------------------------------- reactions
    {
      // Add your reaction, or take it back if it's there.
      method: "POST",
      pattern: "/api/messages/:id/reactions",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        if (store.getMessage(id!).kind !== "post") throw new HttpError(400, "Only posts can have reactions.");
        return json({ reactions: store.reactions.toggle(id!, "user", body.emoji) });
      },
    },
    {
      method: "GET",
      pattern: "/api/emojis",
      handler: () => json({ emojis: store.reactions.listEmojis() }),
    },
    {
      method: "POST",
      pattern: "/api/emojis",
      handler: async (request) => {
        // The image arrives as base64 text inside JSON, like theme files.
        const body = await readObject(request);
        if (typeof body.data !== "string") throw new HttpError(400, '"name" and "data" (base64) are required.');
        const emoji = store.reactions.addEmoji(body.name, Buffer.from(body.data, "base64"));
        return json({ emoji, emojis: store.reactions.listEmojis() });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/emojis/:name",
      handler: (_request, { name }) => {
        store.reactions.removeEmoji(name!);
        return json({ emojis: store.reactions.listEmojis() });
      },
    },

    // ---------------------------------------------------------- rewrites
    {
      // Suggest new words for part of their message: they accept or decline it.
      method: "POST",
      pattern: "/api/messages/:id/rewrites",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        const message = store.getMessage(id!);
        if (message.author !== "friend") throw new HttpError(400, "Rewrites are for your kinwriter's messages: yours, you can just edit.");
        if (hiddenDm(message.channelId)) throw new HttpError(403, "You chose not to see this DM.");
        if (typeof body.quote !== "string" || typeof body.replacement !== "string") throw new HttpError(400, '"quote" and "replacement" must be text.');
        // The words must be in the message (formatting aside), or there's nothing to replace.
        if (body.quote.trim() && applyRewrite(message.content, body.quote, body.replacement) === null) {
          throw new HttpError(400, "Those words aren't in the message. Copy them exactly as they are there.");
        }
        const rewrite = store.rewrites.suggest(id!, body.quote, body.replacement);
        // Something for them to answer: a wake-up, if the rules allow.
        suggested();
        return json({ rewrite, rewrites: store.rewrites.forChannel(message.channelId) });
      },
    },
    {
      method: "POST",
      pattern: "/api/rewrites/:id/withdraw",
      handler: (_request, { id }) => {
        const rewrite = store.rewrites.resolve(id!, "withdrawn");
        return json({ rewrites: store.rewrites.forChannel(store.getMessage(rewrite.messageId).channelId) });
      },
    },

    // ---------------------------------------------------------- comments
    {
      method: "POST",
      pattern: "/api/messages/:id/comments",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        const quote = typeof body.quote === "string" ? body.quote : "";
        const thread = store.comments.start("user", id!, String(body.note ?? ""), quote);
        return json(await commentReply(thread.id));
      },
    },
    {
      method: "POST",
      pattern: "/api/comments/:id/replies",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        store.comments.reply("user", id!, String(body.note ?? ""));
        return json(await commentReply(id!));
      },
    },
    {
      method: "POST",
      pattern: "/api/comments/:id/resolve",
      handler: async (request, { id }) => {
        const body = await readObject(request);
        return json({ thread: store.comments.resolve(id!, body.resolved !== false) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/comments/:id",
      handler: (_request, { id }) => {
        store.comments.delete("user", id!);
        return json({ ok: true });
      },
    },

    // ------------------------------------------------------------- setup
    {
      // After a fresh start (src/fresh.ts): who your new kinwriter is. Their
      // identity begins here, and their first turn is an orientation.
      method: "POST",
      pattern: "/api/setup",
      handler: async (request) => {
        if (store.appState.get(SETUP_PENDING) === null) throw new HttpError(400, "Your kinwriter is already made.");
        const body = await readObject(request);
        const tastes = body.tastes === undefined ? "" : body.tastes;
        if (typeof tastes !== "string") throw new HttpError(400, '"tastes" must be text.');
        const update = validateSettings({
          friendName: body.name,
          ...(body.avatar !== undefined ? { friendAvatar: body.avatar } : {}),
          ...(body.color !== undefined ? { friendColor: body.color } : {}),
          friendPrompt: body.prompt,
        });
        if (!update.friendName?.trim()) throw new HttpError(400, "Give them a name.");
        if (!update.friendPrompt?.trim()) throw new HttpError(400, "Write who they are, or roll someone with Surprise me.");
        store.updateSettings(update);
        store.identity.begin(update.friendPrompt, tastes);
        store.appState.set(SETUP_PENDING, null);
        // The app offers their orientation next (together, on their own, or skip).
        console.log(`[setup] made ${update.friendName}`);
        return json({ settings: store.getSettings() });
      },
    },

    // ------------------------------------------------------- kinwriter page
    {
      method: "GET",
      pattern: "/api/friend-page",
      handler: () => json(kinwriterPage()),
    },
    {
      // Suggest a change to their identity or tastes: they accept or decline it.
      method: "POST",
      pattern: "/api/identity/suggestions",
      handler: async (request) => {
        const body = await readObject(request);
        const change: { identity?: string; tastes?: string; note?: string } = {};
        for (const key of ["identity", "tastes", "note"] as const) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== "string") throw new HttpError(400, `"${key}" must be text.`);
          change[key] = body[key] as string;
        }
        store.identity.suggest(change);
        store.interventions.add({ kind: "settings", summary: "The user suggested a change to your identity." });
        suggested();
        return json(kinwriterPage());
      },
    },
    {
      method: "POST",
      pattern: "/api/identity/suggestions/:id/withdraw",
      handler: (_request, { id }) => {
        store.identity.withdraw(Number(id));
        return json(kinwriterPage());
      },
    },
    {
      // Add a note to "what my writing shows": it arrives as a suggestion.
      method: "POST",
      pattern: "/api/self-page/notes",
      handler: async (request) => {
        const body = await readObject(request);
        if (typeof body.text !== "string") throw new HttpError(400, '"text" must be text.');
        const ids = body.messageIds ?? [];
        if (!Array.isArray(ids) || !ids.every((m) => typeof m === "string")) throw new HttpError(400, '"messageIds" must be a list of message ids.');
        store.selfPage.suggestNote(body.text, ids as string[]);
        store.interventions.add({ kind: "settings", summary: "The user suggested a note for your self-page." });
        suggested();
        return json(kinwriterPage());
      },
    },
    {
      method: "POST",
      pattern: "/api/self-page/notes/:id/withdraw",
      handler: (_request, { id }) => {
        store.selfPage.withdrawNote(id!);
        return json(kinwriterPage());
      },
    },
    // ------------------------------------------------------- orientation
    {
      // Where it stands, and with `?after=<id>`, the live feed since then.
      method: "GET",
      pattern: "/api/orientation",
      handler: (request) => {
        const after = new URL(request.url).searchParams.get("after") ?? undefined;
        return json({ orientation: orientationState(), feed: orientationFeed(store, after) });
      },
    },
    {
      // You pick a version: it starts now (src/orientation.ts).
      method: "POST",
      pattern: "/api/orientation/start",
      handler: async (request) => {
        const body = await readObject(request);
        if (body.version !== "full" && body.version !== "returning") throw new HttpError(400, '"version" is "full" (together) or "returning" (on their own).');
        if (!config.apiKey) throw new HttpError(400, "Add your nanoGPT API key first.");
        try {
          beginOrientation(store, body.version);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : String(error));
        }
        void runOrientation();
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // Together: the next step. Their part (if it has one) starts now;
      // after the last step, it's over.
      method: "POST",
      pattern: "/api/orientation/next",
      handler: () => {
        if (orientationRunning(store)?.version !== "full") throw new HttpError(409, "There's no orientation together running.");
        if (kinwriter.isBusy(orientationRunning(store)!.channelId)) throw new HttpError(409, `${store.getSettings().friendName} is still writing. Next, when they're done.`);
        const step = advanceOrientation(store);
        if (step) void enterStep();
        else console.log("[orientation] finished (the last step)");
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // Your character for the orientation: a name, a line or two, one secret.
      method: "POST",
      pattern: "/api/orientation/character",
      handler: async (request) => {
        const body = await readObject(request);
        const text = (key: string, max: number) => {
          const value = body[key] ?? "";
          if (typeof value !== "string" || value.length > max) throw new HttpError(400, `"${key}" must be text, ${max} characters at most.`);
          return value;
        };
        try {
          makeYourCharacter(store, { name: text("name", 100), about: text("about", 1000), secret: text("secret", 1000) });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // A step you try first: you hand it to them, and their part runs.
      method: "POST",
      pattern: "/api/orientation/hand-over",
      handler: () => {
        const session = orientationRunning(store);
        if (session?.version !== "full") throw new HttpError(409, "There's no orientation together running.");
        if (!waitingForYou(session)) throw new HttpError(409, "This step is already theirs.");
        if (kinwriter.isBusy(session.channelId)) throw new HttpError(409, `${store.getSettings().friendName} is still writing.`);
        handOver(store);
        void handedOver();
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // Your quiet choices, then it ends and every channel opens.
      method: "POST",
      pattern: "/api/orientation/choices",
      handler: async (request) => {
        const session = orientationRunning(store);
        if (!session || currentStep(session)?.id !== "choices") throw new HttpError(409, "There are no choices to make right now.");
        const body = await readObject(request);
        const pick = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
          const value = body[key] ?? fallback;
          if (!options.includes(value as T)) throw new HttpError(400, `"${key}" must be one of: ${options.join(", ")}.`);
          return value as T;
        };
        applyOrientationChoices(store, {
          characters: pick("characters", ["keep", "discard"] as const, "keep"),
          // On their own, the practice scene is discarded unless you keep it.
          scene: pick("scene", ["keep", "discard"] as const, session.version === "full" ? "keep" : "discard"),
          conversation: session.version === "full" ? pick("conversation", ["keep", "set-aside"] as const, "keep") : undefined,
          chattiness: body.chattiness === undefined ? undefined : pick("chattiness", PROACTIVITY_LEVELS, "normal"),
        });
        console.log("[orientation] finished (your choices)");
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // The interview: you keep something to yourself; they see only that you are.
      method: "POST",
      pattern: "/api/orientation/keep",
      handler: async (request) => {
        const body = await readObject(request);
        const note = body.note ?? "";
        if (typeof note !== "string" || note.length > 2000) throw new HttpError(400, '"note" must be text, 2000 characters at most.');
        try {
          keepToYourself(store, note);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return json({ orientation: orientationState() });
      },
    },
    {
      // The library lesson: the example script into the library.
      method: "POST",
      pattern: "/api/orientation/library-example",
      handler: () => {
        try {
          return json({ document: addLibraryExample(store) });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      // Together: you end it, and every channel opens again.
      method: "POST",
      pattern: "/api/orientation/finish",
      handler: () => {
        finishOrientation(store);
        console.log("[orientation] finished");
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // Skip it, for a new kinwriter: nothing runs.
      method: "POST",
      pattern: "/api/orientation/skip",
      handler: () => {
        try {
          skipOrientation(store);
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : String(error));
        }
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },
    {
      // "Not now" to their request: they're told.
      method: "POST",
      pattern: "/api/orientation/decline",
      handler: () => {
        declineOrientation(store);
        return json({ orientation: orientationState(), page: kinwriterPage() });
      },
    },

    {
      // Grant or take back a standing permission (src/standing.ts).
      method: "PUT",
      pattern: "/api/permissions/:key",
      handler: async (request, { key }) => {
        const body = await readObject(request);
        if (typeof body.granted !== "boolean") throw new HttpError(400, '"granted" must be true or false.');
        setGrant(store, key!, body.granted);
        return json(kinwriterPage());
      },
    },

    // ------------------------------------------------------------- inbox
    {
      method: "GET",
      pattern: "/api/inbox",
      handler: () => json({ inbox: store.inbox.open(), recent: store.inbox.recent(30) }),
    },
    {
      method: "POST",
      pattern: "/api/inbox/:id/:action",
      handler: async (request, { id, action }) => {
        const item = store.inbox.get(id!);
        if (action === "answer") {
          const body = await readObject(request);
          if (typeof body.answer !== "string") throw new HttpError(400, '"answer" must be text.');
          store.inbox.answer(id!, body.answer);
          store.interventions.add({ kind: "ask", summary: `The user answered your ask: "${item.text.slice(0, 80)}"` });
          // Your answer can give them a turn of their own, if the rules allow.
          if (autoWake) void wakeups.event("answer");
        } else if (action === "dismiss") {
          store.inbox.dismiss(id!);
          store.interventions.add({ kind: "ask", summary: `The user set aside your ask without answering: "${item.text.slice(0, 80)}"` });
        } else if (action === "approve" || action === "deny") {
          // Deleting a channel waits for a turn in progress there.
          if (action === "approve" && item.kind === "delete_channel" && item.targetId) ensureIdle(item.targetId);
          store.resolveProposal(id!, action === "approve");
        } else {
          throw new HttpError(404, "No such API route.");
        }
        return json({ inbox: store.inbox.open(), channels: channelViews() });
      },
    },

    // ------------------------------------------- profiles and roulettes
    {
      method: "GET",
      pattern: "/api/profiles",
      handler: () => json({ profiles: store.profiles.list(), roulettes: store.profiles.listRoulettes() }),
    },
    {
      method: "POST",
      pattern: "/api/profiles",
      handler: async (request) => json({ profile: store.profiles.create(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/profiles/:id",
      handler: async (request, { id }) => json({ profile: store.profiles.update(id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/profiles/:id",
      handler: (_request, { id }) => {
        store.profiles.delete(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/profiles/:id/test",
      handler: async (_request, { id }) => json({ test: await testToolCalling(api, store.profiles.get(id!)) }),
    },
    {
      method: "POST",
      pattern: "/api/roulettes",
      handler: async (request) => json({ roulette: store.profiles.createRoulette(await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/roulettes/:id",
      handler: async (request, { id }) => {
        const before = new Set(store.profiles.getRoulette(id!).entries.map((e) => e.profileId));
        const roulette = store.profiles.updateRoulette(id!, await readObject(request));
        // A profile new to the roulette: your kinwriter is offered an orientation.
        const added = roulette.entries.filter((e) => !before.has(e.profileId)).map((e) => store.profiles.get(e.profileId).name);
        noteNewProfiles(store, added);
        return json({ roulette });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/roulettes/:id",
      handler: (_request, { id }) => {
        store.profiles.deleteRoulette(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },

    // ------------------------------------------------------ notebook & cast
    // Everything here acts as you ("user"): the notebook checks what you're
    // allowed to do (see src/permissions.ts).
    {
      method: "GET",
      pattern: "/api/notebook",
      handler: () =>
        json({
          folders: store.notebook.listFolders("user"),
          entries: store.notebook.listEntries("user"),
          // Each with who reviews it: you, or your kinwriter (through their tools).
          suggestions: store.notebook
            .listSuggestions("user")
            .map((suggestion) => ({ ...suggestion, reviewer: store.notebook.reviewerOf(suggestion) })),
          templates: ENTRY_TEMPLATES,
        }),
    },
    {
      method: "POST",
      pattern: "/api/notebook/entries",
      handler: async (request) => json({ entry: store.notebook.createEntry("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/entries/:id",
      // Returns { entry } if saved, or { suggestion } if you can only suggest changes.
      handler: async (request, { id }) => json(maybeReview(store.notebook.editEntry("user", id!, await readObject(request)))),
    },
    {
      method: "PUT",
      pattern: "/api/notebook/entries/:id/settings",
      handler: async (request, { id }) =>
        json({ entry: store.notebook.updateEntrySettings("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/entries/:id",
      // Returns { deleted: true }, or { suggestion } for shared lore.
      handler: (_request, { id }) => json(maybeReview(store.notebook.deleteEntry("user", id!))),
    },
    {
      method: "POST",
      pattern: "/api/notebook/folders",
      handler: async (request) => json({ folder: store.notebook.createFolder("user", await readObject(request)) }),
    },
    {
      method: "PATCH",
      pattern: "/api/notebook/folders/:id",
      handler: async (request, { id }) =>
        json({ folder: store.notebook.updateFolder("user", id!, await readObject(request)) }),
    },
    {
      method: "DELETE",
      pattern: "/api/notebook/folders/:id",
      handler: (_request, { id }) => {
        store.notebook.deleteFolder("user", id!);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/notebook/suggestions/:id/:action",
      handler: (_request, { id, action }) => {
        if (action === "withdraw") {
          store.notebook.withdrawSuggestion("user", id!);
          return json({ ok: true });
        }
        if (action !== "accept" && action !== "reject") throw new HttpError(404, "No such API route.");
        const decision = action === "accept" ? "accepted" : "rejected";
        return json({ suggestion: store.notebook.reviewSuggestion("user", id!, decision) });
      },
    },
    {
      method: "PUT",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.pin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/channels/:id/cast/:entryId",
      handler: (_request, { id, entryId }) => {
        const channel = store.getChannel(id!);
        store.notebook.unpin("user", id!, entryId!);
        return json({ channel: channelView(channel) });
      },
    },

    // ------------------------------------------------------------ themes
    {
      method: "GET",
      pattern: "/api/themes",
      handler: () => json({ themes: themes.list() }),
    },
    {
      method: "POST",
      pattern: "/api/themes",
      handler: async (request) => {
        const body = (await readJson(request)) as { name?: unknown; from?: unknown } | null;
        const from = typeof body?.from === "string" ? body.from : DEFAULT_THEME;
        return json({ theme: themes.create(body?.name as string, from) });
      },
    },
    {
      method: "GET",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => json({ theme: themes.details(id!) }),
    },
    {
      method: "PATCH",
      pattern: "/api/themes/:id",
      handler: async (request, { id }) => {
        const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
        return json({ theme: themes.update(id!, body) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id",
      handler: (_request, { id }) => {
        themes.remove(id!);
        // Anything using the theme goes back to the default.
        store.forgetTheme(id!);
        return json({ settings: store.getSettings(), channels: channelViews() });
      },
    },
    {
      method: "POST",
      pattern: "/api/themes/:id/files",
      handler: async (request, { id }) => {
        // Files arrive as base64 text inside JSON, so every request that
        // changes something stays JSON (see checkRequestIsFromTheApp).
        const body = (await readJson(request)) as { name?: unknown; data?: unknown } | null;
        if (typeof body?.name !== "string" || typeof body?.data !== "string") {
          throw new HttpError(400, '"name" and "data" (base64) are required.');
        }
        return json({ files: themes.addFile(id!, body.name, Buffer.from(body.data, "base64")) });
      },
    },
    {
      method: "DELETE",
      pattern: "/api/themes/:id/files/:name",
      handler: (_request, { id, name }) => json({ files: themes.removeFile(id!, name!) }),
    },
  ];

  /**
   * The top-level request handler: API routes, then static files, and turn
   * any thrown error into a JSON error response.
   */
  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Custom emoji images: /emojis/<file>.
    const emojiFile = url.pathname.match(/^\/emojis\/([^/]+)$/);
    if (emojiFile && (request.method === "GET" || request.method === "HEAD")) {
      return store.reactions.serve(emojiFile[1]!) ?? new Response("Not found", { status: 404 });
    }

    // Theme files: /themes/<id>/<file>.
    const themeFile = url.pathname.match(/^\/themes\/([^/]+)\/([^/]+)$/);
    if (themeFile && (request.method === "GET" || request.method === "HEAD")) {
      return themes.serve(themeFile[1]!, themeFile[2]!) ?? new Response("Not found", { status: 404 });
    }

    if (!url.pathname.startsWith("/api/")) {
      return serveStatic(config.publicDir, url.pathname);
    }

    try {
      checkRequestIsFromTheApp(request);
      // A DM you chose not to see has no screen: nothing about it is served.
      const channelId = url.pathname.match(/^\/api\/channels\/([^/]+)/)?.[1];
      if (channelId && hiddenDm(decodeURIComponent(channelId))) return errorResponse(403, "You chose not to see this DM.");
      for (const route of routes) {
        const params = matchRoute(route, request.method, url.pathname);
        if (params) return await route.handler(request, params);
      }
      return errorResponse(404, "No such API route.");
    } catch (error) {
      if (error instanceof HttpError) return errorResponse(error.status, error.message);
      if (error instanceof NotFoundError) return errorResponse(404, error.message);
      if (error instanceof BusyError) return errorResponse(409, error.message);
      if (error instanceof ValidationError) return errorResponse(400, error.message);
      if (error instanceof PermissionError) return errorResponse(403, error.message);
      // A turn you stopped isn't an error: the request that started it just
      // learns that nothing was written.
      if (error instanceof CancelledError) return json({ cancelled: true });
      if (error instanceof ApiError) return errorResponse(502, error.message);
      // Anything else is a bug, not something you did. Log the details for
      // debugging, and send a general message.
      console.error("[server] unexpected error", error);
      return errorResponse(500, "Something went wrong on the server.");
    }
  }

  /**
   * Their last turn before being archived (src/hub.ts): a note in their
   * OOC channel, kept with the archive. No hard rules: it's asked for.
   * Never throws; "" if they wrote nothing (or it failed).
   */
  async function farewell(): Promise<string> {
    const ooc = store.listChannels().find((c) => c.kind === "ooc");
    if (!ooc || !config.apiKey) return "";
    try {
      const result = await kinwriter.takeTurn(ooc.id, "wake", { wake: { reason: "farewell", sinceUser: null, waiting: [] } });
      return result.messages.map((m) => m.content).join("\n");
    } catch (error) {
      console.warn(`[archive] their last turn failed: ${error instanceof Error ? error.message : error}`);
      return "";
    }
  }

  return { fetch, store, kinwriter, themes, summarizer, decider, wakeups, heartbeat, rhythms, presence, notifier, farewell };
}

/**
 * Run a kinwriter turn, but report failure as data instead of throwing.
 * Used after sending a message, where the message itself has already been
 * saved successfully and only the reply failed.
 */
async function tryTurn(
  turn: () => Promise<TurnResult>,
): Promise<Partial<ReturnType<typeof turnResult>> & { error?: string; cancelled?: true }> {
  try {
    return turnResult(await turn());
  } catch (error) {
    if (error instanceof CancelledError) return { cancelled: true };
    if (error instanceof ApiError || error instanceof BusyError) return { error: error.message };
    throw error;
  }
}

/** A turn's result, as the app receives it. */
function turnResult(result: TurnResult) {
  return {
    kinwriterMessages: result.messages,
    toolCalls: result.toolCalls,
    skipped: result.skipped,
    ...(result.thread ? { thread: result.thread } : {}),
  };
}

// -------------------------------------------------------- request helpers

/**
 * Basic protection against other websites using your server.
 *
 * Any web page open in your phone's browser could try to send requests to
 * `http://127.0.0.1:4747`. Browsers block such pages from *reading* the
 * answers, but a simple form-style POST could still make your kinwriter take a
 * turn (and spend your nanoGPT balance). Requiring a JSON content type on
 * every request that changes something stops that: browsers won't send a
 * cross-site JSON request without first asking the server for permission,
 * and this server never gives it.
 */
function checkRequestIsFromTheApp(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new HttpError(415, "API requests that change data must be sent as JSON.");
  }
}

/** Parse the request body as JSON, with a clear error if it isn't. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
}

/**
 * Read the optional `postingAs` field of a message: the name of one of your
 * characters (for casual scenes), or nothing to post as yourself.
 */
function readPostingAs(body: unknown, characters: { name: string }[]): string | null {
  const value = (body as Record<string, unknown> | null)?.postingAs;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !characters.some((c) => c.name === value)) {
    throw new HttpError(400, `"postingAs" must be one of your characters.`);
  }
  return value;
}

/** Read a JSON body that must be an object. */
async function readObject(request: Request): Promise<Record<string, unknown>> {
  const body = await readJson(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Read a required, non-empty text field from a JSON body. */
function requireText(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" must be non-empty text.`);
  }
  if (value.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `"${field}" is too long.`);
  }
  return value;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

// ------------------------------------------------------------ static files

/**
 * Serve a file from `public/`.
 *
 * `/` serves `index.html`. The path is normalised and checked to stay inside
 * the public folder, so a request like `/../.env` can't read files elsewhere.
 */
async function serveStatic(publicDir: string, pathname: string): Promise<Response> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  // `no-cache` means "check with the server before using a cached copy", so
  // updates to the app show up on the next load instead of being stuck behind
  // a stale cache.
  return new Response(file, { headers: { "Cache-Control": "no-cache" } });
}

// --------------------------------------------------------------- start up

/** Start listening. Only runs when this file is executed directly. */
async function main(): Promise<void> {
  const config = loadConfig();
  // One app per kinwriter, grouped into servers (src/hub.ts).
  const { createHub } = await import("./hub.ts");
  const hub = createHub(config);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: hub.fetch,
    // Model replies can take a while; don't let Bun close the connection on
    // a slow generation. (Bun's limit is in seconds, 255 at most; 0 = never.)
    idleTimeout: 0,
  });

  // Catch up on summaries that were due when the server last stopped, and
  // start each kinwriter's heartbeat (which also keeps the phone awake while on).
  hub.start();

  console.log(`Kinaera is running at http://${server.hostname}:${server.port}`);
  console.log(`Saving your data in ${config.dataDir} (${hub.apps.size} kinwriter${hub.apps.size === 1 ? "" : "s"})`);
  if (!config.apiKey) {
    console.warn("Warning: NANOGPT_API_KEY is not set, so your kinwriter can't reply yet. See .env.example.");
  }
}

// `import.meta.main` is true when this file is run with `bun run src/server.ts`,
// and false when the tests import it. That way importing doesn't start a server.
if (import.meta.main) {
  void main();
}
