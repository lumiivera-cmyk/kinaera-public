/**
 * Orientation and the weekly look back.
 *
 * **Orientation** is a live mode you and your kinwriter share (the
 * orientation redesign, KINAERA_ORIENTATION.md). It never runs on its own:
 * something starts only when you pick it.
 *
 *   - **A new kinwriter**: you're offered it, together ("full", the
 *     default) or on their own ("returning"). Skip is under Advanced and
 *     means skip: nothing runs, and their page says they haven't had one.
 *   - **They ask** (`start_orientation`): it becomes a request on their
 *     page, and you pick a version (or say not now). Nothing starts until
 *     you answer.
 *   - **A new profile joins a roulette**: they're told, and can ask.
 *
 * Once picked, it starts at once: no cooldown, no quiet hours, no timer,
 * and its turns run back to back. It happens in their practice channel.
 * Together, you're there with them: you can write in #practice, and every
 * tool they use shows up live (private ones only as having happened). On
 * their own, they go through it alone, then you choose what to keep. While it
 * runs, your other channels with them wait.
 *
 * **The look back**, once a week: a quiet turn with what they wrote in their
 * journal that week, to keep, rewrite or let go of entries. It's queued by
 * a timer (`Rhythms`, every minute) and goes through the hard rules in
 * src/wakeups.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Decider } from "./jev.ts";
import type { LibraryDoc } from "./library.ts";
import type { Store } from "./store.ts";
import { takeReading, WELLBEING_DAYS } from "./wellbeing.ts";
import type { WakeResult, Wakeups } from "./wakeups.ts";
import { fill, wording } from "./wording.ts";

/** Where things are kept between runs (app_state). */
const STATUS = "orientation.status";
const SESSION = "orientation.session";
const REQUEST = "orientation.request";
const DONE_AT = "orientation.done-at";
const WINDOWS = "orientation.windows";
const PROACTIVITY = "proactivity.preference";
const LOOKBACK_LAST = "lookback.last";
const WELLBEING_LAST = "wellbeing.last";

/** How often the look back comes round. */
export const LOOKBACK_DAYS = 7;

/** Together with you, or on their own. */
export type OrientationVersion = "full" | "returning";

/**
 * Where a kinwriter stands: never had one ("none"), asked for one
 * ("requested"), you skipped it ("skipped"), in one ("running"), or had
 * one ("done").
 */
export type OrientationStatus = "none" | "requested" | "skipped" | "running" | "done";

export interface OrientationSession {
  version: OrientationVersion;
  startedAt: string;
  /** Their practice channel, where it happens. */
  channelId: string;
  /** The steps of this orientation, in order (from defaults/orientation.md), and which one it's on. */
  steps: string[];
  step: number;
  /** The starter scene's story channel, once it's made. */
  scene?: string | null;
  /** Together, on a step you try first: whether you've handed it to them yet. */
  handed?: boolean;
  /** When the step it's on began. */
  stepAt?: string;
  /** On their own: the practice scene's canned partner (your notebook entry), and how many of its posts are in. */
  partner?: string | null;
  canned?: number;
  /** On their own: the questions they saved for you, sent to OOC when it ends. */
  questions?: string[];
}

// ---------------------------------------------------------------- steps

/**
 * One step of an orientation, from `defaults/orientation.md`:
 *
 *   ## step-<id>-title       its name
 *   ## step-<id>-card        your card: plain words in the app, no model call
 *   ## step-<id>-kinwriter   their part: the turn they take when the step
 *                            begins, and in their prompt while it lasts
 *   ## step-<id>-followup    another turn straight after, if their first
 *                            wrote a message (for trying to edit it)
 *   ## step-<id>-spotlights  "selector | words" lines: a tour of the real
 *                            interface, one part at a time
 *   ## step-<id>-table       a Markdown table shown on your card
 *   ## step-<id>-where       where their part happens: "practice" (the
 *                            default) or "scene" (the starter scene)
 *   ## step-<id>-after       "you": together, you try your part first, and
 *                            their turn comes when you hand it to them
 *                            (on their own, it comes at once); "message":
 *                            no turn of its own, they answer when you write
 *
 * The steps of each version are listed in `steps-full` and
 * `steps-returning`, one id per line. On their own, only the kinwriter
 * parts are used.
 */
export interface OrientationStep {
  id: string;
  title: string;
  card: string;
  kinwriter: string;
  followup: string;
  spotlights: { selector: string; text: string }[];
  table: string;
  where: "practice" | "scene";
  /** "you": together, their turn waits until you hand the step to them. "message": no turn of its own. */
  after: "start" | "you" | "message";
}

/** The steps of a version, in order. */
export function orientationSteps(version: OrientationVersion): string[] {
  const text = wording("orientation")[version === "full" ? "steps-full" : "steps-returning"] ?? "";
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * One step's wording. On their own ("returning"), a section with `-alone`
 * on the end (like `step-characters-kinwriter-alone`) wins, for wording
 * that would be untrue without you there.
 */
export function orientationStep(id: string, version: OrientationVersion = "full"): OrientationStep {
  const words = wording("orientation");
  const part = (name: string) => (version === "returning" ? words[`step-${id}-${name}-alone`] : undefined) ?? words[`step-${id}-${name}`] ?? "";
  return {
    id,
    title: part("title") || id,
    card: part("card"),
    kinwriter: part("kinwriter"),
    followup: part("followup"),
    spotlights: part("spotlights")
      .split("\n")
      .map((line) => line.split("|").map((p) => p.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1])
      .map(([selector, text]) => ({ selector: selector!, text: text! })),
    table: part("table"),
    where: part("where").trim() === "scene" ? "scene" : "practice",
    after: (["you", "message"] as const).find((a) => a === part("after").trim()) ?? "start",
  };
}

/** The step an orientation is on. */
export function currentStep(session: Pick<OrientationSession, "version" | "steps" | "step">): OrientationStep | null {
  const id = session.steps[session.step];
  return id ? orientationStep(id, session.version) : null;
}

/**
 * Move on to the next step. Returns the new step, or null when there are
 * no more (the orientation is then finished).
 */
export function advanceOrientation(store: Store): OrientationStep | null {
  const session = orientationRunning(store);
  if (!session) return null;
  const next = { ...session, step: session.step + 1, handed: false, stepAt: new Date().toISOString() };
  if (next.step >= next.steps.length) {
    finishOrientation(store);
    return null;
  }
  saveSession(store, next);
  return currentStep(next);
}

export interface OrientationState {
  status: OrientationStatus;
  session: OrientationSession | null;
  /** Their request, if they asked: when, and what they said. */
  request: { note: string | null; at: string } | null;
  /** When their last orientation ended. */
  lastDone: string | null;
}

const json = <T>(value: string | null): T | null => (value ? (JSON.parse(value) as T) : null);

/** Where a kinwriter stands with orientation. */
export function orientationState(store: Store): OrientationState {
  const saved = store.appState.get(STATUS) as OrientationStatus | null;
  // Before the live mode: one who had an orientation the old way has had one.
  const status = saved ?? (store.wakeLog.recent(300).some((w) => w.reason === "orientation" && w.outcome !== "failed") ? "done" : "none");
  return {
    status,
    session: status === "running" ? json<OrientationSession>(store.appState.get(SESSION)) : null,
    request: status === "requested" ? json(store.appState.get(REQUEST)) : null,
    lastDone: store.appState.get(DONE_AT),
  };
}

/** The orientation running now, if there is one. */
export function orientationRunning(store: Store): OrientationSession | null {
  return orientationState(store).session;
}

/** They ask for one (`start_orientation`): a request for you, nothing more. */
export function requestOrientation(store: Store, note?: string): void {
  const { status } = orientationState(store);
  if (status === "running") throw new Error("You're in an orientation now.");
  store.appState.set(REQUEST, JSON.stringify({ note: note?.trim().slice(0, 500) || null, at: new Date().toISOString(), before: status }));
  store.appState.set(STATUS, "requested");
}

/** You say "not now" to their request: they're told (the intervention log). */
export function declineOrientation(store: Store): void {
  const request = json<{ before?: OrientationStatus }>(store.appState.get(REQUEST));
  store.appState.set(STATUS, request?.before && request.before !== "requested" ? request.before : "none");
  store.appState.set(REQUEST, null);
  store.interventions.add({ kind: "settings", summary: "The user said not now to your request for an orientation." });
}

/** You skip it (for a new kinwriter): nothing runs. */
export function skipOrientation(store: Store): void {
  if (orientationState(store).status === "running") throw new Error("An orientation is running: finish it instead.");
  store.appState.set(STATUS, "skipped");
}

/** You pick a version: it begins now, in their practice channel. */
export function beginOrientation(store: Store, version: OrientationVersion): OrientationSession {
  if (orientationState(store).status === "running") throw new Error("An orientation is already running.");
  const session: OrientationSession = { version, startedAt: new Date().toISOString(), channelId: store.ensurePractice().id, steps: orientationSteps(version), step: 0 };
  store.appState.set(SESSION, JSON.stringify(session));
  store.appState.set(REQUEST, null);
  store.appState.set(STATUS, "running");
  return session;
}

/** It ends: every channel opens again. */
export function finishOrientation(store: Store): void {
  const { status, session } = orientationState(store);
  if (status !== "running") return;
  // Remember when it ran: everything saved meanwhile is "from orientation".
  if (session) store.appState.set(WINDOWS, JSON.stringify([...orientationWindows(store), { startedAt: session.startedAt, endedAt: new Date().toISOString() }]));
  store.appState.set(SESSION, null);
  store.appState.set(STATUS, "done");
  store.appState.set(DONE_AT, new Date().toISOString());
}

/** When each orientation ran. */
export function orientationWindows(store: Store): { startedAt: string; endedAt: string }[] {
  const value = store.appState.get(WINDOWS);
  return value ? (JSON.parse(value) as { startedAt: string; endedAt: string }[]) : [];
}

/** The "from orientation" mark: whether something saved at this time was saved during one (or the one running). */
export function fromOrientation(store: Store, at: string): boolean {
  const running = orientationRunning(store);
  if (running && at >= running.startedAt) return true;
  return orientationWindows(store).some((w) => at >= w.startedAt && at <= w.endedAt);
}

// ------------------------------------------------- their proactivity

export const PROACTIVITY_LEVELS = ["off", "quiet", "normal", "chatty"] as const;
export type Proactivity = (typeof PROACTIVITY_LEVELS)[number];

/** How proactive they'd like to be (yours, chattiness, is the ceiling). */
export function proactivityPreference(store: Store): { level: Proactivity; why: string; at: string } | null {
  const value = store.appState.get(PROACTIVITY);
  return value ? (JSON.parse(value) as { level: Proactivity; why: string; at: string }) : null;
}

export function setProactivityPreference(store: Store, level: string, why = ""): void {
  if (!(PROACTIVITY_LEVELS as readonly string[]).includes(level)) throw new Error(`Pick one of: ${PROACTIVITY_LEVELS.join(", ")}.`);
  store.appState.set(PROACTIVITY, JSON.stringify({ level, why: why.trim().slice(0, 500), at: new Date().toISOString() }));
}

// ---------------------------------------------------- their note on you

/** Their private note on you: the relationship notes, with you as one more person. */
export const USER_NOTE_ID = "user";

export function noteOnUser(store: Store): string | null {
  return store.relationships.all().get(USER_NOTE_ID)?.note ?? null;
}

// ---------------------------------------------------- your quiet choices

export interface OrientationChoices {
  /** The characters and lore made during it. */
  characters: "keep" | "discard";
  /** The starter scene's channel (on their own, the practice scene, kept as a starter). */
  scene: "keep" | "discard";
  /** The conversation in #practice (together only). */
  conversation?: "keep" | "set-aside";
  /** Your chattiness from now on (theirs is where it starts). */
  chattiness?: Proactivity;
}

/**
 * Your quiet choices, at the end of the version together, on a screen they
 * don't see. Their map, notes, preference and note on you are saved
 * either way. Each choice is silent in the moment, never hidden: what was
 * discarded or set aside goes in their intervention log. Then it ends.
 */
export function applyOrientationChoices(store: Store, choices: OrientationChoices): void {
  const session = orientationRunning(store);
  if (!session) throw new Error("There's no orientation running.");
  const done: string[] = [];
  if (choices.characters === "discard") {
    // Discarded characters take their "from orientation" notes with them.
    const removed = store.db.query("DELETE FROM notebook_entries WHERE created_at >= $since").run({ since: session.startedAt });
    if (removed.changes > 0) done.push("the characters and lore made in it were discarded");
  }
  if (choices.scene === "discard" && session.scene && store.hasChannel(session.scene)) {
    const name = store.getChannel(session.scene).name;
    store.deleteChannel(session.scene);
    // The canned partner goes with the practice scene.
    if (session.partner) store.db.query("DELETE FROM notebook_entries WHERE id = $id").run({ id: session.partner });
    done.push(`${session.version === "returning" ? "the practice scene" : "its starter scene"}, #${name}, was deleted`);
  }
  if (choices.conversation === "set-aside") {
    const n = store.setAside(session.channelId, session.startedAt);
    if (n > 0) done.push("the orientation conversation was set aside");
  }
  if (choices.chattiness && choices.chattiness !== store.getSettings().wakeups) {
    store.updateSettings({ wakeups: choices.chattiness });
  }
  if (done.length) {
    const text = done.join("; ");
    store.interventions.add({ kind: "settings", summary: `After your orientation, the user chose: ${text}. Your notes from it are all still yours.` });
  }
  // On their own: the questions they saved for you, as their message in OOC.
  const ooc = store.listChannels().find((c) => c.kind === "ooc");
  if (session.questions?.length && ooc) {
    const words = wording("orientation");
    store.addTurn([{ channelId: ooc.id, author: "friend", content: fill(words["questions-message"] ?? "{questions}", { questions: session.questions.map((q) => `- ${q}`).join("\n") }) }]);
  }
  finishOrientation(store);
}

/** The channels an orientation happens in: #practice, and the starter scene once it's made. */
export function orientationChannels(session: OrientationSession): string[] {
  return [session.channelId, ...(session.scene ? [session.scene] : [])];
}

function saveSession(store: Store, session: OrientationSession): void {
  store.appState.set(SESSION, JSON.stringify(session));
}

// ---------------------------------------------------- characters and scene

/** What's been made in the orientation running now: characters and secrets, by whose. */
export function madeInOrientation(store: Store): {
  yours: { id: string; name: string }[];
  theirs: { id: string; name: string }[];
  yourSecrets: number;
  theirSecrets: number;
} {
  const session = orientationRunning(store);
  const empty = { yours: [], theirs: [], yourSecrets: 0, theirSecrets: 0 };
  if (!session) return empty;
  // As you see them: their secrets only as a count, never a name.
  const entries = store.notebook.listEntries("user", true).filter((e) => e.createdAt >= session.startedAt);
  const theirsHidden = store.db
    .query("SELECT COUNT(*) AS n FROM notebook_entries WHERE owner = 'friend' AND created_at >= $since AND COALESCE(visibility, '') = 'hidden'")
    .get({ since: session.startedAt }) as { n: number };
  return {
    yours: entries.filter((e) => e.kind === "character" && e.owner === "user").map((e) => ({ id: e.id, name: e.name })),
    theirs: entries.filter((e) => e.kind === "character" && e.owner === "friend").map((e) => ({ id: e.id, name: e.name })),
    yourSecrets: entries.filter((e) => e.owner === "user" && e.settings.visibility === "hidden").length,
    theirSecrets: theirsHidden.n,
  };
}

/**
 * Your character, small: a name, a line or two, and one secret. The secret
 * is its own entry ("Kestrel's secret"), hidden from your kinwriter with
 * the notebook's own visibility; they're told there is one, never what.
 */
export function makeYourCharacter(store: Store, input: { name: string; about: string; secret: string }): { name: string } {
  if (!orientationRunning(store)) throw new Error("There's no orientation running.");
  const name = input.name.trim();
  if (!name) throw new Error("Give your character a name.");
  const character = store.notebook.createEntry("user", {
    kind: "character",
    name,
    fields: input.about.trim() ? [{ label: "About", value: input.about.trim() }] : [],
  });
  if (input.secret.trim()) {
    store.notebook.createEntry("user", {
      kind: "lore",
      name: `${name}'s secret`,
      fields: [{ label: "Secret", value: input.secret.trim() }],
      visibility: "hidden",
    });
  }
  return { name: character.name };
}

/**
 * The starter scene: a story channel with both characters in its cast,
 * made when its step begins. Later lessons have real material in it: a
 * message to edit, lore to change, a channel to link.
 */
export function makeStarterScene(store: Store): string {
  const session = orientationRunning(store);
  if (!session) throw new Error("There's no orientation running.");
  if (session.scene && store.hasChannel(session.scene)) return session.scene;
  // On their own, the practice scene from defaults/practice-scene.md, with its canned partner.
  const practice = session.version === "returning" ? wording("practice-scene") : null;
  const taken = new Set(store.listChannels().map((c) => c.name));
  const base = practice?.channel?.trim() || "first-scene";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  const channel = store.createChannel({ name, kind: "rp", mode: "literary" });
  const made = madeInOrientation(store);
  for (const c of made.yours) store.notebook.pin("user", channel.id, c.id);
  for (const c of made.theirs) store.notebook.pin("friend", channel.id, c.id);
  let partner: string | null = null;
  if (practice?.["partner-name"]) {
    // The partner is yours (the "yours" column), standing in for you.
    const names = new Set(store.notebook.listEntries("user", true).map((e) => e.name));
    let partnerName = practice["partner-name"].trim();
    for (let i = 2; names.has(partnerName); i++) partnerName = `${practice["partner-name"].trim()} ${i}`;
    const entry = store.notebook.createEntry("user", {
      kind: "character",
      name: partnerName,
      fields: practice["partner-about"]?.trim() ? [{ label: "About", value: practice["partner-about"].trim() }] : [],
    });
    store.notebook.pin("user", channel.id, entry.id);
    partner = entry.id;
  }
  saveSession(store, { ...session, scene: channel.id, partner, canned: 0 });
  if (practice) nextCannedPost(store);
  return channel.id;
}

/** On their own: the canned partner's next post in the practice scene, if there's one left. Returns whether one was posted. */
export function nextCannedPost(store: Store): boolean {
  const session = orientationRunning(store);
  if (!session?.scene || session.version !== "returning") return false;
  const n = (session.canned ?? 0) + 1;
  const post = wording("practice-scene")[`post-${n}`]?.trim();
  if (!post) return false;
  store.addTurn([{ channelId: session.scene, author: "user", content: post }]);
  saveSession(store, { ...session, canned: n });
  return true;
}

/** The library lesson's example text, fetched once by `bun run fetch-example`. */
export const LIBRARY_EXAMPLE = resolve(import.meta.dir, "..", "defaults", "library", "night-of-the-living-dead.md");
const LIBRARY_EXAMPLE_TITLE = "Night of the Living Dead (1968)";

/**
 * Put the example script in the library (for every channel), or find it
 * if it's there already. Throws, in plain words, if it was never fetched.
 */
export function addLibraryExample(store: Store, path = LIBRARY_EXAMPLE): LibraryDoc {
  const already = store.library.list().find((d) => d.title === LIBRARY_EXAMPLE_TITLE);
  if (already) return already;
  if (!existsSync(path)) {
    throw new Error("The example script isn't in this copy of Kinaera yet. Run `bun run fetch-example` once where you have internet, or add any script of your own to the library.");
  }
  const text = readFileSync(path, "utf8");
  // The file's first heading is its title; the paragraph under it, the description.
  const [, description = ""] = text.match(/^# .*\n\n(.*)\n/) ?? [];
  return store.library.add({
    title: LIBRARY_EXAMPLE_TITLE,
    description: description.slice(0, 500),
    channelIds: [],
    content: text.replace(/^# .*\n\n.*\n/, "").trim(),
  });
}

/** Whether their part of this step is still waiting for you to hand it over (together only). */
export function waitingForYou(session: Pick<OrientationSession, "version" | "steps" | "step" | "handed">): boolean {
  return session.version === "full" && currentStep(session)?.after === "you" && !session.handed;
}

/** You hand the step to them: their turn comes now. */
export function handOver(store: Store): void {
  const session = orientationRunning(store);
  if (!session) throw new Error("There's no orientation running.");
  saveSession(store, { ...session, handed: true });
}

/**
 * What a step needs before their part: the starter scene's channel, and,
 * on their own, the library example (together, you add it yourself).
 */
export function prepareStep(store: Store): void {
  const session = orientationRunning(store);
  const step = session ? currentStep(session) : null;
  if (!session || !step) return;
  if (step.where === "scene") makeStarterScene(store);
  if (step.id === "library" && session.version === "returning") {
    try {
      addLibraryExample(store);
    } catch {
      // Not fetched: their part reads whatever the library has.
    }
  }
}

/** The interview's question cards (defaults/interview.md): for you to ask them, and for them to ask you. */
export function interviewCards(): { forKinwriter: string[]; forUser: string[] } {
  const words = wording("interview");
  const lines = (name: string) => (words[name] ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return { forKinwriter: lines("for-kinwriter"), forUser: lines("for-user") };
}

/** Whether they're in the interview right now (or, on their own, its questionnaire). */
export function interviewing(store: Store): boolean {
  const session = orientationRunning(store);
  return Boolean(session && ["interview", "questionnaire"].includes(currentStep(session)?.id ?? ""));
}

/** On their own: the questions they'd like to ask you, saved for after. */
export function saveQuestions(store: Store, questions: string[]): string[] {
  const session = orientationRunning(store);
  if (!session) throw new Error("There's no orientation running.");
  const clean = questions.map((q) => q.trim().replace(/\s+/g, " ").slice(0, 500)).filter(Boolean).slice(0, 10);
  saveSession(store, { ...session, questions: clean });
  return clean;
}

/**
 * Tool bingo, for the version on their own: a square for each tool they
 * have, filled as they use it (private ones too, without what they wrote).
 * Reflex reminders are Jev's, not theirs, so they fill nothing.
 */
export function orientationBingo(store: Store, tools: string[]): { tools: string[]; used: string[]; secrets: number } {
  const session = orientationRunning(store);
  if (!session) return { tools, used: [], secrets: 0 };
  // Reflex reminders and their keep_my_draft answer are about the check, not a tool of theirs.
  const used = new Set(orientationFeed(store).filter((f) => f.ok && f.tool !== "reflex" && f.tool !== "keep_my_draft").map((f) => f.tool));
  // A tool offered only on one step (like save_questions_for_user) keeps its square once used.
  const all = [...tools, ...[...used].filter((t) => !tools.includes(t))];
  return { tools: all, used: all.filter((t) => used.has(t)), secrets: madeInOrientation(store).theirSecrets };
}

/**
 * You keep something to yourself in the interview: they see only that you
 * are. With a note, it's kept for you in the notebook, hidden from them.
 */
export function keepToYourself(store: Store, note = ""): void {
  const session = orientationRunning(store);
  if (!session || !interviewing(store)) throw new Error("There's no interview going on.");
  const words = wording("interview");
  if (note.trim()) {
    const base = words["kept-user-note"] ?? "Kept to myself";
    const taken = new Set(store.notebook.listEntries("user").map((e) => e.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    store.notebook.createEntry("user", { kind: "lore", name, fields: [{ label: "Note", value: note.trim().slice(0, 2000) }], visibility: "hidden" });
  }
  store.addTurn([{ channelId: session.channelId, author: "user", content: words["kept-user"] ?? "(I'm keeping something to myself.)" }]);
}

/** One line of the live feed: a tool they used, in readable words. */
export interface FeedItem {
  id: string;
  at: string;
  tool: string;
  /** What they did ("checked the notebook for the lighthouse"); for a private tool, only that it happened. */
  text: string;
  ok: boolean;
}

/**
 * The tools they've used during the orientation running now, oldest first:
 * from the tool log, which keeps private tools' content out already.
 */
export function orientationFeed(store: Store, after?: string): FeedItem[] {
  const session = orientationRunning(store);
  if (!session) return [];
  const channels = orientationChannels(session);
  const rows = (
    store.db
      .query(`SELECT id, name, summary, status, created_at FROM tool_calls WHERE channel_id IN (${channels.map(() => "?").join(", ")}) AND created_at >= ? ORDER BY created_at, rowid`)
      .all(...channels, session.startedAt) as { id: string; name: string; summary: string; status: string; created_at: string }[]
  );
  const items = rows.map((r) => ({ id: r.id, at: r.created_at, tool: r.name, text: r.status === "ok" ? r.summary || r.name : `tried ${r.name}, which didn't work`, ok: r.status === "ok" }));
  if (!after) return items;
  const index = items.findIndex((i) => i.id === after);
  return index === -1 ? items : items.slice(index + 1);
}

/** Where a profile new to a roulette is noted, until your kinwriter's next turn. */
export const NEW_PROFILE = "orientation.new-profile";

/**
 * A profile joined a roulette: your kinwriter is told on their next turn that
 * a new model may be writing as them, and offered an orientation (not run).
 */
export function noteNewProfiles(store: Store, names: string[]): void {
  if (names.length === 0) return;
  const earlier = store.appState.get(NEW_PROFILE);
  const all = new Set([...(earlier ? earlier.split(", ") : []), ...names]);
  store.appState.set(NEW_PROFILE, [...all].join(", "));
}

/**
 * The orientation guide, put together from `defaults/orientation.md`: only
 * the steps whose tools your kinwriter has this turn.
 */
/**
 * The catalog of everything they can do, from `orientation-catalog`: each
 * "- tool, tool: what it's for" line is kept only if they have one of its
 * tools this turn, and each "### heading" only if it has lines left.
 */
export function orientationCatalog(tools: string[], text: string): string {
  const out: string[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (heading !== null && lines.length) out.push(`${heading}\n${lines.join("\n")}`);
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("### ")) {
      flush();
      heading = line.slice(4).trim();
      continue;
    }
    const item = line.match(/^-\s*([a-z_, ]+):\s*(.+)$/);
    if (item && heading !== null) {
      const names = item[1]!.split(",").map((n) => n.trim()).filter((n) => tools.includes(n));
      if (names.length) lines.push(`- ${names.join(", ")}: ${item[2]}`);
      continue;
    }
    if (heading === null && line.trim()) out.push(line.trim());
  }
  flush();
  return out.join("\n\n");
}

/**
 * Their part of a step, as their prompt carries it: how this orientation
 * works (together or on their own), where they are in it, and the step's
 * own words. `{catalog}` in a step becomes everything they can do (only
 * the tools they have), and `{suggestions}` a few things to try with them.
 * `followup` is the step's second turn, straight after a first that wrote
 * a message.
 */
export function orientationGuide(
  tools: string[],
  session: Pick<OrientationSession, "version" | "steps" | "step" | "handed" | "scene">,
  followup = false,
  store?: Store,
): string {
  const words = wording("orientation");
  // Together, the user is right there; on their own, they aren't.
  const framing = words[session.version === "full" ? "orientation-together" : "orientation-alone"] ?? "";
  const step = currentStep(session);
  const has = (name: string) => tools.includes(name);
  const suggestions = [
    has("check") ? words["orientation-check"] : "",
    // With drafts, a message can be posted and edited in one turn.
    has("post_draft") && has("edit_my_message") ? words["orientation-draft"] : has("edit_my_message") ? words["orientation-edit"] : "",
    has("schedule_wakeup") ? words["orientation-schedule"] : "",
    has("read_prompt_manifest") ? words["orientation-manifest"] : "",
    has("consult") ? words["orientation-consult"] : "",
    has("ask") ? words["orientation-ask"] : "",
  ]
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
  const own = followup ? (step?.followup ?? "") : (step?.kinwriter ?? "");
  const where = step ? fill(words["orientation-where"] ?? "", { n: session.step + 1, count: session.steps.length, title: step.title }) : "";
  // The starter scene by name, and what's in the library, for the lessons.
  const scene = session.scene && store?.hasChannel(session.scene) ? `#${store.getChannel(session.scene).name}` : "the starter scene";
  const docs = store ? store.library.list() : [];
  const library = docs.length ? docs.map((d) => `- ${d.title}${d.description ? `: ${d.description}` : ""}`).join("\n") : (words["orientation-library-empty"] ?? "");
  return [
    framing,
    words["orientation-intro"] ?? "",
    where,
    waitingForYou(session) ? (words["orientation-waiting"] ?? "") : "",
    fill(own, {
      catalog: orientationCatalog(tools, words["orientation-catalog"] ?? ""),
      suggestions,
      scene,
      library,
      cards: interviewCards().forUser.map((q) => `- ${q}`).join("\n"),
      asked: interviewCards().forKinwriter.map((q) => `- ${q}`).join("\n"),
    }),
  ]
    .filter((part) => part.trim())
    .join("\n\n");
}

/** When the next wellbeing reading is due, and taking it. */
function due(last: string | null, now: Date, days: number): boolean {
  return last !== null && now.getTime() - new Date(last).getTime() >= days * 86_400_000;
}

/** Runs what's due every minute: scheduled wake-ups, the wellbeing reading, the look back. (Orientation never runs on a timer.) */
export class Rhythms {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly wakeups: Wakeups,
    private readonly now: () => Date = () => new Date(),
    /** Jev, for the weekly wellbeing reading (set up after this, by the server). */
    private readonly decider: () => Decider | null = () => null,
  ) {}

  start(checkMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), checkMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Take the week's wellbeing reading if one is due (the first a week after this version starts). */
  private async wellbeingIfDue(): Promise<void> {
    const now = this.now();
    const last = this.store.appState.get(WELLBEING_LAST);
    if (!last) {
      this.store.appState.set(WELLBEING_LAST, now.toISOString());
      return;
    }
    if (!due(last, now, WELLBEING_DAYS)) return;
    this.store.appState.set(WELLBEING_LAST, now.toISOString());
    const reading = await takeReading(this.store, this.decider(), new Date(last), now);
    console.log(`[wellbeing] weekly reading: ${reading.verdict ?? `none (${reading.error})`}`);
  }

  /** Start what's due: a wake-up they scheduled, then the look back. Never throws. */
  async tick(): Promise<WakeResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      // A wake-up they scheduled for themselves (src/schedule.ts), soonest
      // first. Held by a rule, it stays waiting for the next tick.
      const scheduled = this.store.schedule.due(this.now())[0];
      if (scheduled) {
        const result = await this.wakeups.event("scheduled", { scheduleId: scheduled.id, channelId: scheduled.channelId ?? undefined });
        if (result.outcome !== null) this.store.schedule.markDone(scheduled.id);
        return result;
      }
      // The weekly wellbeing reading (src/wellbeing.ts), before the look
      // back, which shows it. It costs one Jev call; nothing else waits on it.
      await this.wellbeingIfDue();

      // The first look back is a week after the journal starts being kept here.
      const last = this.store.appState.get(LOOKBACK_LAST);
      if (!last) {
        this.store.appState.set(LOOKBACK_LAST, this.now().toISOString());
        return null;
      }
      if (this.now().getTime() - new Date(last).getTime() < LOOKBACK_DAYS * 86_400_000) return null;
      const result = await this.wakeups.event("lookback", { since: last });
      if (result.outcome !== null) this.store.appState.set(LOOKBACK_LAST, this.now().toISOString());
      return result;
    } catch (error) {
      console.warn(`[rhythms] ${error instanceof Error ? error.message : error}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
