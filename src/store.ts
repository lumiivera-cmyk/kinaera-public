/**
 * The store: reading and writing Kinaera's data.
 *
 * Everything lives in an SQLite database (`data/kinaera.db`); the table
 * layout is described in `src/db.ts`. The rest of the server only talks to
 * the store through the methods of the `Store` class below, and never writes
 * SQL itself. That keeps every query in one place.
 *
 * All methods are synchronous. Bun's SQLite driver answers immediately
 * (there is no network in between), so there is nothing to wait for.
 */

import { Rewrites } from "./rewrites.ts";
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { BACKGROUND_FILE } from "./backgrounds.ts";
import { Notebook } from "./notebook.ts";
import { Profiles } from "./profiles.ts";
import { Comments, ReasoningLog, ToolLog } from "./activity.ts";
import { Inbox } from "./inbox.ts";
import { CheckLog } from "./check.ts";
import { Summaries } from "./summaries.ts";
import { WakeLog } from "./wakeups.ts";
import { Library } from "./library.ts";
import { Reactions } from "./reactions.ts";
import { AppState } from "./appstate.ts";
import { Interventions } from "./interventions.ts";
import { Identity } from "./identity.ts";
import { SeedArchive } from "./seeds.ts";
import { Journal } from "./journal.ts";
import { SelfPage } from "./selfpage.ts";
import { Verbatim } from "./verbatim.ts";
import { Schedule } from "./schedule.ts";
import { Drafts } from "./drafts.ts";
import { Continuity } from "./continuity.ts";
import { Wellbeing } from "./wellbeing.ts";
import { Relationships } from "./relationships.ts";
import { granted } from "./standing.ts";
import { awaitExampleCharacter, builtInWorld } from "./practiceworld.ts";
import { deletePads } from "./scratchpads.ts";
import { defaultText } from "./wording.ts";
import type {
  Category,
  Author,
  Branch,
  BranchSummary,
  MessageAuthor,
  Channel,
  ChannelKind,
  ChannelMode,
  EntryField,
  Message,
  MessageHistory,
  MessageKind,
  Revision,
  Settings,
} from "./types.ts";

// The error types live in src/errors.ts; re-exported here for server.ts,
// which still imports them from the store.
export { NotFoundError, ValidationError };

/** Jev's model on nanoGPT, pinned: upgrade on purpose, not by surprise (see src/jev.ts). */
export const DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";

// ------------------------------------------------------------- defaults

/**
 * Settings used until you change them. The kinwriter prompts come from
 * `defaults/*.md` so they're easy to read and edit as plain text.
 *
 * Settings are merged over these every time they're read, so a setting added
 * in a newer version of Kinaera quietly gets its default.
 */
export function defaultSettings(): Settings {
  return {
    kinwriterName: "Arlo",
    // Which profile writes each job. "" means the first profile. (Models and
    // their settings live in connection profiles; see src/profiles.ts.)
    rpAssignment: "",
    oocAssignment: "",
    themeOptions: {},
    kinwriterPrompt: readDefault("kinwriter.md"),
    literaryPrompt: readDefault("literary.md"),
    casualPrompt: readDefault("casual.md"),
    oocPrompt: readDefault("ooc.md"),
    historyLimit: 40,
    summaries: true,
    summaryEvery: 20,
    summaryAssignment: "",
    decisionModel: DEFAULT_DECISION_MODEL,
    decisionFallback: "",
    decisionConfidence: 0.8,
    wakeups: "normal",
    awayHours: 4,
    wakeCooldownMinutes: 60,
    asideMinutes: 30,
    scripts: false,
    hardLimits: "",
    quietStart: -1,
    quietEnd: 8,
    heartbeatHours: 0,
    heartbeatAssignment: "",
    kinwriterAvatar: "",
    kinwriterPronouns: "",
    kinwriterColor: -1,
    oocBubbles: true,
    matchPace: true,
    typingBaseMs: 600,
    typingPerCharMs: 40,
    replyDelayMs: 2500,
    appTheme: "classic",
    appBackground: "",
    backgroundDim: 0,
  };
}

/**
 * The fixed example character, for tests (a real server writes one for its
 * kinwriter: see src/practiceworld.ts), from `defaults/character.md`: one
 * `Label: text` line per field, and a `Name:` line for their name. Blank
 * lines are skipped.
 */
export function defaultCharacter(): { name: string; fields: EntryField[] } {
  const fields: EntryField[] = [];
  for (const line of readDefault("character.md").split("\n")) {
    const match = line.match(/^\s*([^:\n]{1,30}):\s*(.+)$/);
    if (match) fields.push({ label: match[1]!.trim(), value: match[2]!.trim() });
  }
  const name = fields.find((f) => f.label.toLowerCase() === "name")?.value ?? "Ilse Marrow";
  return { name, fields: fields.filter((f) => f.label.toLowerCase() !== "name") };
}

/** `defaults/<fileName>`, trimmed, or "" if there's no such file (read by src/wording.ts). */
function readDefault(fileName: string): string {
  return defaultText(fileName.replace(/\.md$/, "")).trim();
}

// ------------------------------------------------------------ validation

/**
 * Limits for each field. The validators below use these to reject nonsense
 * (a negative temperature, a 10 MB channel name) before it is saved.
 */
const LIMITS = {
  historyLimit: { min: 1, max: 1000 },
  summaryEvery: { min: 2, max: 500 },
  decisionConfidence: { min: 0.5, max: 0.99 },
  awayHours: { min: 0.25, max: 720 },
  wakeCooldownMinutes: { min: 1, max: 10_080 },
  asideMinutes: { min: -1, max: 1440 },
  hour: { min: -1, max: 23 },
  heartbeatHours: { min: 0, max: 168 },
  typingBaseMs: { min: 0, max: 10_000 },
  typingPerCharMs: { min: 0, max: 1000 },
  replyDelayMs: { min: 0, max: 30_000 },
  backgroundDim: { min: 0, max: 0.8 },
  /** Longest kinwriter prompt, in characters. */
  longText: 100_000,
  /** Longest name (channel, kinwriter), in characters. */
  name: 100,
} as const;

/**
 * Check a partial settings update coming from the browser.
 *
 * Anything arriving over the network is untrusted, even from your own app, so
 * each field is checked for the right type and range. Unknown fields are
 * dropped. Returns the cleaned update, or throws an error describing the first
 * problem found.
 */
export function validateSettings(input: unknown): Partial<Settings> {
  const raw = requireObject(input, "Settings");
  const clean: Partial<Settings> = {};

  if (raw.kinwriterName !== undefined) clean.kinwriterName = name(raw.kinwriterName, "kinwriterName");
  for (const key of ["kinwriterPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"] as const) {
    if (raw[key] !== undefined) clean[key] = longText(raw[key], key);
  }

  // Only the form is checked here; the server checks the profile or
  // roulette exists.
  if (raw.rpAssignment !== undefined) clean.rpAssignment = assignment(raw.rpAssignment, "rpAssignment") ?? "";
  if (raw.oocAssignment !== undefined) clean.oocAssignment = assignment(raw.oocAssignment, "oocAssignment") ?? "";
  if (raw.summaryAssignment !== undefined) {
    clean.summaryAssignment = assignment(raw.summaryAssignment, "summaryAssignment") ?? "";
  }
  if (raw.heartbeatAssignment !== undefined) {
    clean.heartbeatAssignment = assignment(raw.heartbeatAssignment, "heartbeatAssignment") ?? "";
  }
  if (raw.hardLimits !== undefined) {
    if (typeof raw.hardLimits !== "string" || raw.hardLimits.length > 4000) throw new ValidationError("hardLimits must be text, 4000 characters at most");
    clean.hardLimits = raw.hardLimits.trim();
  }
  if (raw.historyLimit !== undefined) {
    clean.historyLimit = numberInRange(raw.historyLimit, "historyLimit", LIMITS.historyLimit, true);
  }
  if (raw.summaryEvery !== undefined) {
    clean.summaryEvery = numberInRange(raw.summaryEvery, "summaryEvery", LIMITS.summaryEvery, true);
  }
  if (raw.decisionModel !== undefined) {
    if (typeof raw.decisionModel !== "string" || raw.decisionModel.trim().length > 200) {
      throw new ValidationError("decisionModel must be a model id");
    }
    clean.decisionModel = raw.decisionModel.trim();
  }
  if (raw.decisionFallback !== undefined) {
    const value = assignment(raw.decisionFallback, "decisionFallback") ?? "";
    if (value.startsWith("roulette:")) throw new ValidationError("decisionFallback must be a profile, not a roulette");
    clean.decisionFallback = value;
  }
  if (raw.decisionConfidence !== undefined) {
    clean.decisionConfidence = numberInRange(raw.decisionConfidence, "decisionConfidence", LIMITS.decisionConfidence, false);
  }
  if (raw.wakeups !== undefined) {
    if (!["off", "quiet", "normal", "chatty"].includes(raw.wakeups as string)) {
      throw new ValidationError('wakeups must be "off", "quiet", "normal" or "chatty"');
    }
    clean.wakeups = raw.wakeups as Settings["wakeups"];
  }
  if (raw.awayHours !== undefined) clean.awayHours = numberInRange(raw.awayHours, "awayHours", LIMITS.awayHours, false);
  if (raw.asideMinutes !== undefined) clean.asideMinutes = numberInRange(raw.asideMinutes, "asideMinutes", LIMITS.asideMinutes, true);
  if (raw.scripts !== undefined) {
    if (typeof raw.scripts !== "boolean") throw new ValidationError("scripts must be true or false");
    clean.scripts = raw.scripts;
  }
  if (raw.wakeCooldownMinutes !== undefined) {
    clean.wakeCooldownMinutes = numberInRange(raw.wakeCooldownMinutes, "wakeCooldownMinutes", LIMITS.wakeCooldownMinutes, true);
  }
  for (const key of ["quietStart", "quietEnd"] as const) {
    if (raw[key] !== undefined) clean[key] = numberInRange(raw[key], key, LIMITS.hour, true);
  }
  if (raw.heartbeatHours !== undefined) {
    clean.heartbeatHours = numberInRange(raw.heartbeatHours, "heartbeatHours", LIMITS.heartbeatHours, false);
    // Five minutes at the shortest (hours, so 0.25 is every 15 minutes).
    if (clean.heartbeatHours > 0 && clean.heartbeatHours < 5 / 60) throw new ValidationError("heartbeatHours must be 0 (off) or at least 5 minutes (0.0834)");
  }
  if (raw.kinwriterAvatar !== undefined) {
    if (typeof raw.kinwriterAvatar !== "string" || [...raw.kinwriterAvatar.trim()].length > 8) {
      throw new ValidationError("kinwriterAvatar must be an emoji (or empty)");
    }
    clean.kinwriterAvatar = raw.kinwriterAvatar.trim();
  }
  if (raw.kinwriterPronouns !== undefined) {
    if (typeof raw.kinwriterPronouns !== "string" || raw.kinwriterPronouns.trim().length > 40) throw new ValidationError("kinwriterPronouns must be text, 40 characters at most");
    clean.kinwriterPronouns = raw.kinwriterPronouns.trim();
  }
  if (raw.kinwriterColor !== undefined) clean.kinwriterColor = numberInRange(raw.kinwriterColor, "kinwriterColor", { min: -1, max: 359 }, true);
  if (raw.oocBubbles !== undefined) {
    if (typeof raw.oocBubbles !== "boolean") throw new ValidationError("oocBubbles must be true or false");
    clean.oocBubbles = raw.oocBubbles;
  }
  if (raw.matchPace !== undefined) {
    if (typeof raw.matchPace !== "boolean") throw new ValidationError("matchPace must be true or false");
    clean.matchPace = raw.matchPace;
  }
  for (const key of ["typingBaseMs", "typingPerCharMs", "replyDelayMs"] as const) {
    if (raw[key] !== undefined) clean[key] = numberInRange(raw[key], key, LIMITS[key], true);
  }
  if (raw.summaries !== undefined) {
    if (typeof raw.summaries !== "boolean") throw new ValidationError("summaries must be true or false");
    clean.summaries = raw.summaries;
  }
  // Only the id's form is checked here; the server checks the theme exists.
  if (raw.appTheme !== undefined) clean.appTheme = themeId(raw.appTheme, "appTheme");
  if (raw.themeOptions !== undefined) clean.themeOptions = themeOptions(raw.themeOptions);
  // Only the name's form is checked here; the server checks the picture exists.
  if (raw.appBackground !== undefined) {
    if (raw.appBackground !== "" && (typeof raw.appBackground !== "string" || !BACKGROUND_FILE.test(raw.appBackground))) {
      throw new ValidationError("appBackground must be a background picture's file name, or empty");
    }
    clean.appBackground = raw.appBackground;
  }
  if (raw.backgroundDim !== undefined) clean.backgroundDim = numberInRange(raw.backgroundDim, "backgroundDim", LIMITS.backgroundDim, false);

  return clean;
}

/**
 * A profile or roulette assignment: `"profile:<id>"` or `"roulette:<id>"`.
 * `null` or `""` means none (returned as `null`).
 */
function assignment(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^(profile|roulette):[\w-]{1,100}$/.test(value)) {
    throw new ValidationError(`${field} must be "profile:<id>" or "roulette:<id>"`);
  }
  return value;
}

/**
 * Slider values for themes: `{ "rainy-window": { "bubble-transparency": 0.6 } }`.
 * Only the shape is checked; each theme's own ranges are applied by the app.
 */
function themeOptions(value: unknown): Settings["themeOptions"] {
  const themes = requireObject(value, "themeOptions");
  const entries = Object.entries(themes);
  if (entries.length > 100) throw new ValidationError("themeOptions has too many themes");
  return Object.fromEntries(
    entries.map(([id, options]) => {
      themeId(id, "themeOptions");
      const values = Object.entries(requireObject(options, "themeOptions"));
      if (values.length > 20) throw new ValidationError("themeOptions has too many options for one theme");
      for (const [key, number] of values) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || typeof number !== "number" || !Number.isFinite(number)) {
          throw new ValidationError("themeOptions values must be numbers, by option id");
        }
      }
      return [id, Object.fromEntries(values) as Record<string, number>];
    }),
  );
}

/** A theme id: lowercase letters, digits and dashes. */
function themeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)) {
    throw new ValidationError(`${field} must be a theme id`);
  }
  return value;
}

/** Check a channel mode. */
function mode(value: unknown): ChannelMode {
  if (value !== "literary" && value !== "casual") throw new ValidationError('mode must be "literary" or "casual"');
  return value;
}

/** The fields you give when creating a channel. */
export interface NewChannel {
  name: string;
  kind: ChannelKind;
  /** RP channels: the first scene's mode. Defaults to literary. */
  mode?: ChannelMode;
}

/** Check the body of a "create channel" request. */
export function validateNewChannel(input: unknown): NewChannel {
  const raw = requireObject(input, "Channel");
  if (raw.kind !== "rp" && raw.kind !== "ooc") {
    throw new ValidationError('kind must be "rp" or "ooc"');
  }
  return {
    name: name(raw.name, "name"),
    kind: raw.kind,
    ...(raw.mode !== undefined ? { mode: mode(raw.mode) } : {}),
  };
}

/**
 * The channel fields that can be changed after creation. `mode` is the mode
 * you *ask* for; see `Store.updateChannel` for when it takes effect.
 */
export type ChannelUpdate = Partial<Pick<Channel, "name" | "mode" | "theme" | "assignment" | "categoryId" | "about">>;

/** How long a channel's "what it's for" line can be. */
const CHANNEL_ABOUT_LIMIT = 300;

/** Check a partial channel update. The kind can't be changed, so it's ignored. */
export function validateChannelUpdate(input: unknown): ChannelUpdate {
  const raw = requireObject(input, "Channel");
  const clean: ChannelUpdate = {};
  if (raw.name !== undefined) clean.name = name(raw.name, "name");
  if (raw.mode !== undefined) clean.mode = mode(raw.mode);
  // `null` (or "") means "use the app theme".
  if (raw.theme !== undefined) clean.theme = raw.theme === null || raw.theme === "" ? null : themeId(raw.theme, "theme");
  // `null` (or "") means "use the profile Settings assigns to this kind of channel".
  if (raw.assignment !== undefined) clean.assignment = assignment(raw.assignment, "assignment");
  // `null` (or "") means "in no category". The store checks it exists.
  if (raw.categoryId !== undefined) {
    if (raw.categoryId !== null && typeof raw.categoryId !== "string") throw new ValidationError("categoryId must be a category id, or null");
    clean.categoryId = raw.categoryId || null;
  }
  if (raw.about !== undefined) {
    const about = raw.about === null ? "" : raw.about;
    if (typeof about !== "string") throw new ValidationError("about must be text");
    const line = about.trim().replace(/\s+/g, " ");
    if (line.length > CHANNEL_ABOUT_LIMIT) throw new ValidationError(`Keep what a channel is for to one line (${CHANNEL_ABOUT_LIMIT} characters at most).`);
    clean.about = line;
  }
  return clean;
}

function requireObject(input: unknown, what: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ValidationError(`${what} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}

/** A required, non-empty, reasonably short piece of text, trimmed. */
function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be non-empty text`);
  if (value.trim().length > LIMITS.name) throw new ValidationError(`${field} is too long`);
  return value.trim();
}

function longText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text`);
  if (value.length > LIMITS.longText) throw new ValidationError(`${field} is too long`);
  return value;
}

function numberInRange(
  value: unknown,
  field: string,
  range: { min: number; max: number },
  wholeNumber: boolean,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  if (wholeNumber && !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`);
  }
  if (value < range.min || value > range.max) {
    throw new ValidationError(`${field} must be between ${range.min} and ${range.max}`);
  }
  return value;
}

// ----------------------------------------------------------- row mapping

/*
 * The database uses snake_case column names (`channel_id`), while the rest
 * of the code uses camelCase (`channelId`). These types describe rows exactly
 * as SQLite returns them, and the functions below convert them.
 */

interface ChannelRow {
  id: string;
  name: string;
  kind: ChannelKind;
  mode: ChannelMode;
  pending_mode: ChannelMode | null;
  theme: string | null;
  assignment: string | null;
  position: number;
  category_id: string | null;
  created_at: string;
  paused_reason: string | null;
  paused_at: string | null;
  about: string;
}

interface CategoryRow {
  id: string;
  name: string;
  position: number;
  collapsed: number;
  created_at: string;
}

interface MessageRow {
  id: string;
  channel_id: string;
  kind: MessageKind;
  mode: ChannelMode | null;
  turn_id: string | null;
  author: MessageAuthor;
  speaker_id: string | null;
  speaker_name: string | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  edited_by: Author | null;
  deleted_at: string | null;
  deleted_by: Author | null;
  superseded_by: string | null;
  alternates: number;
  model: string | null;
  profile: string | null;
  reply_to: string | null;
  /** A JSON array of character names, built by the query itself. */
  characters: string;
  /** A JSON array of attached notebook entry ids, built by the query itself. */
  attachments: string;
  /** A JSON array of {emoji, author}, built by the query itself. */
  reactions: string;
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mode: row.mode,
    pendingMode: row.pending_mode,
    theme: row.theme,
    assignment: row.assignment,
    position: row.position,
    categoryId: row.category_id,
    createdAt: row.created_at,
    paused: row.paused_reason !== null ? { reason: row.paused_reason, at: row.paused_at ?? row.created_at } : null,
    about: row.about ?? "",
  };
}

function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, position: row.position, collapsed: row.collapsed === 1, createdAt: row.created_at };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    kind: row.kind,
    author: row.author,
    content: row.content,
    mode: row.mode,
    turnId: row.turn_id,
    characters: JSON.parse(row.characters) as string[],
    attachments: JSON.parse(row.attachments) as string[],
    reactions: JSON.parse(row.reactions) as Message["reactions"],
    createdAt: row.created_at,
    // Only include optional fields when they have a value.
    alternates: row.alternates,
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.edited_by ? { editedBy: row.edited_by } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at, deletedBy: row.deleted_by! } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    ...(row.speaker_id ? { speaker: { id: row.speaker_id, name: row.speaker_name ?? "" } } : {}),
  };
}

/**
 * The start of every query that reads messages. For each message, the inner
 * `SELECT` gathers the characters it voices from `message_characters`, in
 * order, into one JSON array (`json_group_array`), so one query returns
 * everything about a message.
 */
const SELECT_MESSAGES = `
  SELECT m.id, m.channel_id, m.kind, m.mode, m.turn_id, m.author, m.content, m.created_at, m.edited_at, m.model, m.profile, m.reply_to, m.speaker_id, m.speaker_name,
    m.edited_by, m.deleted_at, m.deleted_by, m.superseded_by,
    (SELECT COUNT(DISTINCT COALESCE(a.turn_id, a.id)) FROM messages a
       WHERE m.turn_id IS NOT NULL AND a.superseded_by = m.turn_id AND a.channel_id = m.channel_id AND a.deleted_at IS NULL) AS alternates,
    (SELECT json_group_array(character_name)
       FROM (SELECT character_name FROM message_characters
              WHERE message_id = m.id ORDER BY position)) AS characters,
    (SELECT json_group_array(entry_id) FROM message_attachments WHERE message_id = m.id) AS attachments,
    (SELECT json_group_array(json_object('emoji', emoji, 'author', author))
       FROM (SELECT emoji, author FROM reactions WHERE message_id = m.id ORDER BY created_at, rowid)) AS reactions
  FROM messages m`;

/**
 * Messages that are in the chat: not deleted, and not replaced by a
 * regeneration. (Those stay in the table, for history.)
 */
const LIVE = "m.deleted_at IS NULL AND m.superseded_by IS NULL";

/** How `superseded_by` marks a message set aside in a branch (see `Store.branchFrom`). */
const BRANCH = "branch:";

/**
 * The fork "message" of a branch that starts at the very beginning of the
 * channel: what's left of one whose fork message (the channel's first) was
 * deleted. It's always there to go back to.
 */
export const CHANNEL_START = "start";

/** A branch's fork message id (or `CHANNEL_START`), or `null` if `mark` isn't a branch's (a regeneration's turn id). */
function forkOf(mark: string): string | null {
  if (!mark.startsWith(BRANCH)) return null;
  const end = mark.lastIndexOf(":");
  return end > BRANCH.length ? mark.slice(BRANCH.length, end) : null;
}

// ----------------------------------------------------------------- store

/** The fields you give when adding a message. */
export interface NewMessage {
  channelId: string;
  author: MessageAuthor;
  /** A peer's message (group channels, DMs): which kinwriter wrote it. */
  speaker?: { id: string; name: string };
  content: string;
  characters?: string[];
  model?: string;
  /** The name of the profile that wrote it (kinwriter messages). */
  profile?: string;
  /** Defaults to "post". Use `addSceneBreak` for scene breaks. */
  kind?: MessageKind;
  /** RP channels: the mode it was written in. Defaults to `null`. */
  mode?: ChannelMode | null;
  /** Shared by messages written together. Defaults to `null`. */
  turnId?: string | null;
  /** The message this one answers (a reply), if any. */
  replyTo?: string | null;
}

export class Store {
  readonly db: Database;
  /** Characters, lore and each channel's cast (see `src/notebook.ts`). */
  readonly notebook: Notebook;
  /** Connection profiles and roulettes (see `src/profiles.ts`). */
  readonly profiles: Profiles;
  /** Every tool call your kinwriter makes (see `src/activity.ts`). */
  readonly toolLog: ToolLog;
  /** A thinking model's reasoning, per round of a turn (src/activity.ts). */
  readonly reasoning: ReasoningLog;
  /** Your suggested rewrites of parts of their messages (src/rewrites.ts). */
  readonly rewrites: Rewrites;
  /** Comment threads on messages. */
  readonly comments: Comments;
  /** What your kinwriter asks of you: asks, and proposals to approve (see `src/inbox.ts`). */
  readonly inbox: Inbox;
  /** Every check your kinwriter made (see `src/check.ts`). */
  readonly checkLog: CheckLog;
  /** Scene summaries, the story so far and the digest (see `src/summaries.ts`). */
  readonly summaries: Summaries;
  /** The reference library: long texts your kinwriter can search. */
  readonly library: Library;
  /** Emoji reactions on messages, and custom emojis. */
  readonly reactions: Reactions;
  /** Small values kept between runs. */
  readonly appState: AppState;
  /** Everything you do that affects your kinwriter (see `src/interventions.ts`). */
  readonly interventions: Interventions;
  /** Your kinwriter's identity and tastes, every version kept (see `src/identity.ts`). */
  readonly identity: Identity;
  /** The seed they were made from, kept read-only (src/seeds.ts). */
  readonly seeds: SeedArchive;
  /** Your kinwriter's self-page (see `src/selfpage.ts`). */
  readonly selfPage: SelfPage;
  /** Your kinwriter's private journal (see `src/journal.ts`). */
  readonly journal: Journal;
  /** Moments your kinwriter asked to keep in full (see `src/verbatim.ts`). */
  readonly verbatim: Verbatim;
  /** Wake-ups your kinwriter set for themselves (stage 5). */
  readonly schedule: Schedule;
  /** Your kinwriter's private drafts (stage 5). */
  readonly drafts: Drafts;
  /** Voice marks, "not me" flags and profile notes (stage 6, src/continuity.ts). */
  readonly continuity: Continuity;
  /** The weekly wellbeing readings (stage 6, src/wellbeing.ts). */
  readonly wellbeing: Wellbeing;
  /** Their private notes on the other kinwriters (stage 7, src/relationships.ts). */
  readonly relationships: Relationships;
  /** Your kinwriter's recent wake-ups, and what came of them (see `src/wakeups.ts`). */
  readonly wakeLog: WakeLog;
  /**
   * Goes up by one whenever any message changes (added, edited, deleted).
   * The app checks it to notice new messages it didn't ask for, like a
   * wake-up (stage 8).
   */
  revision = 0;
  private readonly messageWatchers: ((channelId: string) => void)[] = [];

  /**
   * Be told whenever a channel's messages change (added, edited, deleted):
   * summaries catch up (src/summarizer.ts).
   */
  watchMessages(watcher: (channelId: string) => void): void {
    this.messageWatchers.push(watcher);
  }

  private messagesChanged(channelId: string): void {
    this.afterCommit(() => {
      this.revision++;
      for (const watcher of this.messageWatchers) watcher(channelId);
    });
  }

  /** Notifications held back until `atomically`'s transaction commits (`null` outside one). */
  private deferred: (() => void)[] | null = null;

  /** Run `notify` now, or once the surrounding `atomically` transaction commits (never, if it rolls back). */
  private afterCommit(notify: () => void): void {
    if (this.deferred) this.deferred.push(notify);
    else notify();
  }

  /**
   * Run `work` in one transaction, holding back message notifications (the
   * summarizer, and group copies) until it commits: if it rolls back,
   * nobody hears of messages that were never saved.
   */
  private atomically<T>(work: () => T): T {
    if (this.deferred) return this.db.transaction(work)();
    this.deferred = [];
    let held: (() => void)[];
    try {
      const result = this.db.transaction(work)();
      held = this.deferred;
      this.deferred = null;
      for (const notify of held) notify();
      return result;
    } finally {
      this.deferred = null;
    }
  }

  /**
   * Told when a message is added, edited or deleted here (not when a copy
   * arrives from another kinwriter's store): group channels and DMs mirror it
   * to the others (src/groups.ts).
   */
  onMessageEvent: ((event: "added" | "edited" | "deleted", message: Message) => void) | null = null;

  private messageEvent(event: "added" | "edited" | "deleted", message: Message): void {
    this.afterCommit(() => {
      try {
        this.onMessageEvent?.(event, message);
      } catch (error) {
        console.warn("[store] couldn't pass on a message change", error);
      }
    });
  }

  // ------------------------------------------------ mirrored (group) copies

  /** A message another kinwriter's store sent (group channels, DMs): saved as is, under the same id. */
  mirrorAdd(message: NewMessage & { id: string; createdAt: string }): void {
    if (this.db.query("SELECT 1 FROM messages WHERE id = $id").get({ id: message.id })) return;
    this.addMessage({ ...message, mirrored: true });
  }

  /** An edit made in another kinwriter's store. The owner's own copy keeps the revision; copies just follow. */
  mirrorEdit(id: string, content: string): void {
    if (!this.hasMessage(id)) return;
    const message = this.getMessage(id);
    // Summaries that cover it are out of date now, as with `editMessage`.
    if (!message.deletedAt && !message.supersededBy && content !== message.content) this.summaries.messageChanging(message, false);
    this.db.query("UPDATE messages SET content = $content, edited_at = $now WHERE id = $id").run({ id, content, now: new Date().toISOString() });
    this.messagesChanged(message.channelId);
  }

  /** A deletion made in another kinwriter's store. */
  mirrorDelete(id: string): void {
    if (!this.hasMessage(id)) return;
    const message = this.getMessage(id);
    if (!message.deletedAt && !message.supersededBy) this.summaries.messageChanging(message, true);
    this.db.query("UPDATE messages SET deleted_at = $now WHERE id = $id AND deleted_at IS NULL").run({ id, now: new Date().toISOString() });
    this.messagesChanged(message.channelId);
  }

  private hasMessage(id: string): boolean {
    return this.db.query("SELECT 1 FROM messages WHERE id = $id").get({ id }) !== null;
  }

  /**
   * Open (or create) the database inside `dataDir`.
   *
   * The very first time, the database is filled with starting content: a
   * `#story` channel with the example character pinned to it, and an `#ooc`
   * channel.
   *
   * @param dataDir  Folder for the database. Created if it doesn't exist.
   *                 Pass `":memory:"` for a throwaway database (for tests).
   */
  constructor(dataDir: string, options: { example?: boolean | "generate" } = {}) {
    const inMemory = dataDir === ":memory:";
    if (!inMemory) mkdirSync(dataDir, { recursive: true });
    const path = inMemory ? ":memory:" : join(dataDir, "kinaera.db");

    this.db = openDatabase(path);
    // New if it has no channels at all (the practice channel is always made,
    // so only a fresh database has none): a new file, or one left empty.
    const isNew = this.db.query("SELECT 1 FROM channels LIMIT 1").get() === null;
    this.notebook = new Notebook(this.db);
    this.profiles = new Profiles(this.db);
    this.toolLog = new ToolLog(this.db);
    this.reasoning = new ReasoningLog(this.db);
    this.rewrites = new Rewrites(this.db);
    this.comments = new Comments(this.db);
    this.inbox = new Inbox(this.db);
    this.checkLog = new CheckLog(this.db);
    this.summaries = new Summaries(this.db);
    this.library = new Library(this.db, (id) => this.hasChannel(id));
    // In memory (tests), custom emoji files go to a throwaway folder.
    this.reactions = new Reactions(this.db, inMemory ? join(tmpdir(), `kinaera-emojis-${crypto.randomUUID()}`) : dataDir, () => this.revision++);
    this.wakeLog = new WakeLog(this.db);
    this.appState = new AppState(this.db);
    this.interventions = new Interventions(this.db);
    this.identity = new Identity(this.db, (identity) => this.updateSettings({ kinwriterPrompt: identity }));
    this.seeds = new SeedArchive(this.db);
    this.selfPage = new SelfPage(this.db);
    this.journal = new Journal(this.db);
    this.verbatim = new Verbatim(this.db);
    this.schedule = new Schedule(this.db);
    this.drafts = new Drafts(this.db);
    this.continuity = new Continuity(this.db);
    this.wellbeing = new Wellbeing(this.db);
    this.relationships = new Relationships(this.db);
    // Standing permission to edit your entries directly (src/standing.ts).
    this.notebook.directEdits = () => granted(this, "edit-notebook");

    // All of the starting content, or none: a crash halfway can't leave a
    // store that looks set up but has no #story.
    this.db.transaction(() => {
      // A new kinwriter is offered an orientation in the app (src/orientation.ts); nothing runs by itself.
      if (isNew) this.seed(options.example ?? true);
      // Every kinwriter has an identity of their own, and a practice channel.
      if (!this.identity.current()) this.identity.begin(this.getSettings().kinwriterPrompt, isNew && options.example !== false ? readDefault("tastes.md") : "");
      this.ensurePractice();
    })();
  }

  /**
   * Orientation's practice channel and Practice folder (src/orientation.ts),
   * made if they aren't there yet: the channel, and the built-in practice
   * notes (defaults/practice.md) pinned only to it, until an orientation
   * writes a world of their own (src/practiceworld.ts).
   */
  ensurePractice(): Channel {
    let channel = this.practiceChannel();
    if (!channel) channel = this.createChannel({ name: "practice", kind: "practice" });
    if (!this.notebook.practiceFolder()) {
      const folder = this.notebook.createPracticeFolder();
      for (const note of builtInWorld().notes) {
        const entry = this.notebook.createEntry("kinwriter", { kind: note.kind, name: note.name, fields: note.fields });
        this.notebook.updateEntrySettings("kinwriter", entry.id, { folderId: folder.id });
        this.notebook.pin("kinwriter", channel.id, entry.id);
      }
    }
    return channel;
  }

  /**
   * Starting content for a brand-new kinwriter: a #story and an #ooc channel,
   * and (for the very first kinwriter) an example character in #story. With
   * `"generate"`, the character is written for them once a model can be
   * reached (src/practiceworld.ts); with `true`, it's the fixed one in
   * `defaults/character.md` (for tests).
   */
  private seed(example: boolean | "generate"): void {
    const story = this.createChannel({ name: "story", kind: "rp" });
    this.createChannel({ name: "ooc", kind: "ooc" });
    if (!example) return;
    if (example === "generate") {
      awaitExampleCharacter(this, story.id);
      return;
    }
    const character = defaultCharacter();
    const entry = this.notebook.createEntry("user", {
      kind: "character",
      owner: "kinwriter",
      name: character.name,
      fields: character.fields,
    });
    this.notebook.pin("user", story.id, entry.id);
  }

  /** Whether it's been closed (its kinwriter deleted, archived or set aside): background work stops then. */
  get closed(): boolean {
    return this.isClosed;
  }
  private isClosed = false;

  /** Close the database: when its kinwriter stops, and in tests, which open many. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // Everything into the main file first: Bun can keep a closed connection
    // around until it's collected, so its write-ahead log may stay behind.
    // Then a copy of the folder (or a renamed one) is complete on its own.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // In memory, or already closed: nothing to fold in.
    }
    this.db.close();
  }

  // -------------------------------------------------------------- settings

  /** The current settings, with defaults for anything never changed. */
  getSettings(): Settings {
    const rows = this.db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
    return { ...defaultSettings(), ...saved };
  }

  /** Save an already-validated settings update. Returns the new settings. */
  updateSettings(update: Partial<Settings>): Settings {
    // "Upsert": insert the key, or if it already exists, update its value.
    const upsert = this.db.query(
      "INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(update)) {
        if (value !== undefined) upsert.run({ key, value: JSON.stringify(value) });
      }
    })();
    return this.getSettings();
  }

  // -------------------------------------------------------------- channels

  /**
   * Every channel, in sidebar order. The practice channel isn't one of them:
   * it's your kinwriter's own, shown apart (see `practiceChannel`).
   */
  listChannels(): Channel[] {
    const rows = this.db.query("SELECT * FROM channels WHERE kind != 'practice' ORDER BY position").all() as ChannelRow[];
    const hide = this.hideShared();
    return rows.map(toChannel).filter((c) => !hide || !isShared(c));
  }

  /**
   * Whether group channels and DMs are out of sight (the hub's Kinwriters
   * together switch is off): left out of the channel list, so of every
   * prompt, tool and screen, though kept in the database.
   */
  hideShared: () => boolean = () => false;

  /** Your kinwriter's practice channel (made with the store, so always there after startup). */
  practiceChannel(): Channel | null {
    const row = this.db.query("SELECT * FROM channels WHERE kind = 'practice'").get() as ChannelRow | null;
    return row ? toChannel(row) : null;
  }

  /** One channel. Throws `NotFoundError` if there's no such channel. */
  getChannel(id: string): Channel {
    const row = this.db.query("SELECT * FROM channels WHERE id = $id").get({ id }) as ChannelRow | null;
    if (!row) throw new NotFoundError("channel");
    return toChannel(row);
  }

  /** Whether a channel exists. */
  hasChannel(id: string): boolean {
    return this.db.query("SELECT 1 FROM channels WHERE id = $id").get({ id }) !== null;
  }

  /** Create a channel at the bottom of the sidebar. */
  createChannel(input: NewChannel & { categoryId?: string | null; id?: string }): Channel {
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM channels WHERE kind != 'practice'").get() as {
      next: number;
    };
    // A group channel or DM has the same id in every kinwriter's store (src/groups.ts).
    const id = input.id ?? crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO channels (id, name, kind, mode, position, category_id, created_at)
         VALUES ($id, $name, $kind, $mode, $position, $categoryId, $createdAt)`,
      )
      .run({
        id,
        name: input.name,
        kind: input.kind,
        mode: input.mode ?? "literary",
        position: next,
        categoryId: input.categoryId ? this.getCategory(input.categoryId).id : null,
        createdAt: new Date().toISOString(),
      });
    return this.getChannel(id);
  }

  /**
   * Change a channel's name, mode or theme. Returns the updated channel.
   * (Its cast is changed by pinning entries; see `src/notebook.ts`.)
   *
   * A mode change follows the design's rule that a scene never mixes
   * styles:
   *
   *   - If the current scene has no messages yet (a new channel, or just
   *     after a scene break), the new mode applies right away.
   *   - Otherwise it's saved as `pendingMode` and applies at the next scene
   *     break (`addSceneBreak`). Asking for the current mode again cancels
   *     a pending change.
   */
  updateChannel(id: string, update: ChannelUpdate): Channel {
    const channel = this.getChannel(id); // throws if missing
    const { mode: requestedMode, ...rest } = update;
    const merged = { ...channel, ...rest };
    if (requestedMode !== undefined && channel.kind === "rp") {
      if (this.currentSceneIsEmpty(id)) {
        merged.mode = requestedMode;
        merged.pendingMode = null;
      } else {
        merged.pendingMode = requestedMode === channel.mode ? null : requestedMode;
      }
    }
    this.db
      .query(
        `UPDATE channels SET name = $name, mode = $mode, pending_mode = $pendingMode, theme = $theme,
                assignment = $assignment, category_id = $categoryId, about = $about
         WHERE id = $id`,
      )
      .run({
        id,
        name: merged.name,
        mode: merged.mode,
        pendingMode: merged.pendingMode,
        theme: merged.theme,
        assignment: merged.assignment,
        categoryId: merged.categoryId === null ? null : this.getCategory(merged.categoryId).id,
        about: merged.about,
      });
    return this.getChannel(id);
  }

  /**
   * Stop using a theme that's been deleted: the app theme goes back to
   * Classic, and channels using it go back to the app theme.
   */
  forgetTheme(themeId: string): void {
    this.db.transaction(() => {
      const settings = this.getSettings();
      if (settings.appTheme === themeId) this.updateSettings({ appTheme: "classic" });
      if (settings.themeOptions[themeId]) {
        const { [themeId]: _gone, ...rest } = settings.themeOptions;
        this.updateSettings({ themeOptions: rest });
      }
      this.db.query("UPDATE channels SET theme = NULL WHERE theme = $themeId").run({ themeId });
    })();
  }

  /**
   * Whether the channel's current scene has no messages yet: nothing after
   * its latest scene break, or nothing at all if it has none.
   */
  currentSceneIsEmpty(channelId: string): boolean {
    const { count } = this.db
      .query(
        `SELECT COUNT(*) AS count FROM messages m
          WHERE m.channel_id = $channelId AND m.kind = 'post' AND ${LIVE}
            AND m.seq > COALESCE(
              (SELECT MAX(seq) FROM messages m WHERE m.channel_id = $channelId AND m.kind = 'scene_break' AND ${LIVE}), 0)`,
      )
      .get({ channelId }) as { count: number };
    return count === 0;
  }

  /**
   * Put the channels in a new order.
   *
   * @param ids  Every channel id, in the new order. Leaving one out or adding
   *             an unknown one is an error, so the order can never end up
   *             with gaps or duplicates.
   */
  reorderChannels(ids: string[], categoryOf?: Record<string, string | null>): Channel[] {
    // Group channels and DMs are ordered by the hub, not here.
    const existing = new Set(this.listChannels().filter((c) => !isShared(c)).map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every channel exactly once.");
    }
    // Moving channels between categories (a drag in the sidebar) happens
    // with the new order, all at once.
    const categories = new Set(this.listCategories().map((c) => c.id));
    for (const [channelId, categoryId] of Object.entries(categoryOf ?? {})) {
      if (!existing.has(channelId)) throw new ValidationError("categories must map channel ids to category ids.");
      if (categoryId !== null && !categories.has(categoryId)) throw new NotFoundError("category");
    }
    const setPosition = this.db.query("UPDATE channels SET position = $position WHERE id = $id");
    const setCategory = this.db.query("UPDATE channels SET category_id = $categoryId WHERE id = $id");
    this.db.transaction(() => {
      ids.forEach((id, position) => setPosition.run({ id, position }));
      for (const [id, categoryId] of Object.entries(categoryOf ?? {})) setCategory.run({ id, categoryId });
    })();
    return this.listChannels();
  }

  // ------------------------------------------------------------ categories

  /** Every category, in sidebar order. */
  listCategories(): Category[] {
    return (this.db.query("SELECT * FROM categories ORDER BY position, created_at").all() as CategoryRow[]).map(toCategory);
  }

  getCategory(id: string): Category {
    const row = this.db.query("SELECT * FROM categories WHERE id = $id").get({ id }) as CategoryRow | null;
    if (!row) throw new NotFoundError("category");
    return toCategory(row);
  }

  /** Make a category, at the bottom. */
  createCategory(input: unknown): Category {
    const raw = requireObject(input, "Category");
    const id = crypto.randomUUID();
    const { next } = this.db.query("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM categories").get() as { next: number };
    this.db
      .query("INSERT INTO categories (id, name, position, collapsed, created_at) VALUES ($id, $name, $next, 0, $now)")
      .run({ id, name: name(raw.name, "name"), next, now: new Date().toISOString() });
    return this.getCategory(id);
  }

  /** Rename a category, or fold it up (or open it). */
  updateCategory(id: string, input: unknown): Category {
    const raw = requireObject(input, "Category");
    const current = this.getCategory(id);
    if (raw.collapsed !== undefined && typeof raw.collapsed !== "boolean") throw new ValidationError("collapsed must be true or false");
    this.db.query("UPDATE categories SET name = $name, collapsed = $collapsed WHERE id = $id").run({
      id,
      name: raw.name !== undefined ? name(raw.name, "name") : current.name,
      collapsed: (raw.collapsed ?? current.collapsed) ? 1 : 0,
    });
    return this.getCategory(id);
  }

  /** Delete a category. Its channels stay, outside any category. */
  deleteCategory(id: string): void {
    this.getCategory(id);
    this.db.query("DELETE FROM categories WHERE id = $id").run({ id });
  }

  /** Put the categories in a new order (every one, exactly once). */
  reorderCategories(ids: string[]): Category[] {
    const existing = new Set(this.listCategories().map((c) => c.id));
    const given = new Set(ids);
    if (given.size !== ids.length || given.size !== existing.size || ids.some((id) => !existing.has(id))) {
      throw new ValidationError("The new order must list every category exactly once.");
    }
    const set = this.db.query("UPDATE categories SET position = $position WHERE id = $id");
    this.db.transaction(() => ids.forEach((id, position) => set.run({ id, position })))();
    return this.listCategories();
  }

  /**
   * Your kinwriter pauses a roleplay storyline (`pause_storyline`), with their
   * reason, or picks it back up (`reason` null). You still can write there.
   */
  setPaused(id: string, reason: string | null): Channel {
    const channel = this.getChannel(id);
    if (channel.kind !== "rp") throw new ValidationError("Only roleplay channels have a storyline to pause.");
    const clean = reason?.trim().slice(0, 500) ?? null;
    if (reason !== null && !clean) throw new ValidationError("Say why you're pausing it: the user sees your reason.");
    this.db
      .query("UPDATE channels SET paused_reason = $reason, paused_at = $at WHERE id = $id")
      .run({ id, reason: clean, at: clean ? new Date().toISOString() : null });
    return this.getChannel(id);
  }

  /**
   * Delete a channel and, through `ON DELETE CASCADE`, all its messages.
   * Throws `NotFoundError` if there's no such channel.
   */
  deleteChannel(id: string): void {
    if (this.hasChannel(id) && this.getChannel(id).kind === "practice") {
      throw new ValidationError("The practice channel is your kinwriter's own, and can't be deleted.");
    }
    const result = this.db.query("DELETE FROM channels WHERE id = $id").run({ id });
    if (result.changes === 0) throw new NotFoundError("channel");
    this.library.channelDeleted(id);
    deletePads(this.db, id);
  }

  // -------------------------------------------------------------- messages

  /**
   * Every message in a channel's chat, oldest first: not deleted ones, or
   * replies that were regenerated (those are in `history`).
   */
  getMessages(channelId: string): Message[] {
    this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const rows = this.db.query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND ${LIVE} ORDER BY m.seq`).all({
      channelId,
    }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * One message, even a deleted or replaced one (see `deletedAt` and
   * `supersededBy`). Throws `NotFoundError` if there's no such message.
   */
  getMessage(id: string): Message {
    const row = this.db.query(`${SELECT_MESSAGES} WHERE m.id = $id`).get({ id }) as MessageRow | null;
    if (!row) throw new NotFoundError("message");
    return toMessage(row);
  }

  /** One message that's in the chat. Throws `NotFoundError` if it isn't (deleted or replaced). */
  getLiveMessage(id: string): Message {
    const message = this.getMessage(id);
    if (message.deletedAt || message.supersededBy) throw new NotFoundError("message");
    return message;
  }

  /** The newest message in a channel's chat, or `undefined` if it's empty. */
  lastMessage(channelId: string): Message | undefined {
    const row = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND ${LIVE} ORDER BY m.seq DESC LIMIT 1`)
      .get({ channelId }) as MessageRow | null;
    return row ? toMessage(row) : undefined;
  }

  /**
   * Add a message to the end of a channel.
   *
   * @param createdAt  Only for importing old messages; new ones get "now".
   */
  addMessage(input: NewMessage & { id?: string; createdAt?: string; editedAt?: string; mirrored?: boolean }): Message {
    const id = input.id ?? crypto.randomUUID();
    const insertMessage = this.db.query(
      `INSERT INTO messages (id, channel_id, kind, mode, turn_id, author, content, created_at, edited_at, model, profile, reply_to, speaker_id, speaker_name)
       VALUES ($id, $channelId, $kind, $mode, $turnId, $author, $content, $createdAt, $editedAt, $model, $profile, $replyTo, $speakerId, $speakerName)`,
    );
    const insertCharacter = this.db.query(
      "INSERT OR IGNORE INTO message_characters (message_id, character_name, position) VALUES ($id, $name, $position)",
    );

    // The message and its characters are saved together or not at all.
    this.db.transaction(() => {
      insertMessage.run({
        id,
        channelId: input.channelId,
        kind: input.kind ?? "post",
        mode: input.mode ?? null,
        turnId: input.turnId ?? null,
        author: input.author,
        content: input.content,
        createdAt: input.createdAt ?? new Date().toISOString(),
        editedAt: input.editedAt ?? null,
        model: input.model ?? null,
        profile: input.profile ?? null,
        replyTo: input.replyTo ?? null,
        speakerId: input.speaker?.id ?? null,
        speakerName: input.speaker?.name ?? null,
      });
      (input.characters ?? []).forEach((name, position) => insertCharacter.run({ id, name, position }));
    })();

    this.messagesChanged(input.channelId);
    const saved = this.getMessage(id);
    if (!input.mirrored) this.messageEvent("added", saved);
    return saved;
  }

  /**
   * Add several messages at once, all or nothing, sharing a new turn id.
   * Used for a casual reply's bubbles, or several lines you sent together.
   */
  addTurn(messages: Omit<NewMessage, "turnId">[], turnId: string = crypto.randomUUID()): Message[] {
    return this.atomically(() => messages.map((m) => this.addMessage({ ...m, turnId })));
  }

  /**
   * Put a scene break at the end of a channel.
   *
   * If a mode change is waiting (`pendingMode`), this is where it takes
   * effect: the new scene starts in the new mode. Both happen in one
   * transaction.
   *
   * @returns The scene break, and the channel as it is afterwards.
   */
  addSceneBreak(channelId: string, author: Author, title: string): { sceneBreak: Message; channel: Channel } {
    const channel = this.getChannel(channelId); // throws if missing
    if (channel.kind !== "rp") throw new ValidationError("Scene breaks are only for roleplay channels.");

    return this.atomically(() => {
      const sceneBreak = this.addMessage({ channelId, author, content: title.trim(), kind: "scene_break" });
      if (channel.pendingMode) {
        this.db
          .query("UPDATE channels SET mode = pending_mode, pending_mode = NULL WHERE id = $channelId")
          .run({ channelId });
      }
      return { sceneBreak, channel: this.getChannel(channelId) };
    });
  }

  /**
   * The kinwriter's most recent turn in a channel: every message of it (one
   * for a literary post, several bubbles for a casual reply), oldest first.
   * Empty if the channel doesn't end on a kinwriter post.
   */
  lastKinwriterTurn(channelId: string): Message[] {
    const last = this.lastMessage(channelId);
    if (!last || last.kind !== "post" || last.author !== "kinwriter") return [];
    if (!last.turnId) return [last];
    const rows = this.db
      .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.turn_id = $turnId AND ${LIVE} ORDER BY m.seq`)
      .all({ channelId, turnId: last.turnId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Change a message's text. Nothing is overwritten: the first edit also
   * saves the original, and every version is kept (see `history`).
   *
   * @param by  Who's editing. Your kinwriter may only edit their own messages.
   * @throws NotFoundError   if the message isn't in the chat.
   * @throws ValidationError if your kinwriter tries to edit someone else's.
   */
  editMessage(id: string, content: string, by: Author = "user"): Message {
    const message = this.getLiveMessage(id);
    if (by === "kinwriter" && message.author !== "kinwriter") throw new ValidationError("You can only edit your own messages.");
    if (content === message.content) return message;
    this.summaries.messageChanging(message, false);
    const now = new Date().toISOString();
    // Another kinwriter's message (a group channel): its history is kept in
    // their own store, where it's theirs. Here the copy just follows.
    if (message.author === "peer") {
      this.db.query("UPDATE messages SET content = $content, edited_at = $now, edited_by = $by WHERE id = $id").run({ id, content, now, by });
      this.messagesChanged(message.channelId);
      const edited = this.getMessage(id);
      this.messageEvent("edited", edited);
      return edited;
    }
    this.db.transaction(() => {
      const insert = this.db.query(
        "INSERT INTO message_revisions (message_id, content, author, created_at) VALUES ($id, $content, $author, $at)",
      );
      const { n } = this.db.query("SELECT COUNT(*) AS n FROM message_revisions WHERE message_id = $id").get({ id }) as { n: number };
      if (n === 0) insert.run({ id, content: message.content, author: message.author, at: message.createdAt });
      insert.run({ id, content, author: by, at: now });
      this.db.query("UPDATE messages SET content = $content, edited_at = $now, edited_by = $by WHERE id = $id").run({ id, content, now, by });
      if (by === "user" && message.author === "kinwriter") {
        this.interventions.add({
          kind: "edit",
          summary: `The user edited ${message.kind === "scene_break" ? "the title of a scene break you made" : "your message"} in #${this.getChannel(message.channelId).name}.`,
          channelId: message.channelId,
          messageId: id,
        });
      }
    })();
    this.messagesChanged(message.channelId);
    const edited = this.getMessage(id);
    this.messageEvent("edited", edited);
    return edited;
  }

  /**
   * Delete a message: it leaves the chat (and every prompt), but stays in
   * history as a tombstone.
   *
   * @param by  Who's deleting. Your kinwriter may only delete their own messages.
   */
  deleteMessage(id: string, by: Author = "user"): void {
    const message = this.getLiveMessage(id);
    if (by === "kinwriter" && message.author !== "kinwriter") throw new ValidationError("You can only delete your own messages.");
    this.summaries.messageChanging(message, true);
    this.db.transaction(() => {
      this.rehomeBranches(message);
      this.db.query("UPDATE messages SET deleted_at = $now, deleted_by = $by WHERE id = $id").run({ id, now: new Date().toISOString(), by });
      if (by === "user" && message.author === "kinwriter") {
        this.interventions.add({
          kind: "delete",
          summary: `The user deleted ${message.kind === "scene_break" ? "a scene break you made" : "your message"} in #${this.getChannel(message.channelId).name}: "${snippet(message.content)}"`,
          channelId: message.channelId,
          messageId: id,
        });
      }
    })();
    this.messagesChanged(message.channelId);
    this.messageEvent("deleted", this.getMessage(id));
  }

  /**
   * Set aside a channel's messages since a time (your choice after an
   * orientation): out of the conversation, the way a deleted message is,
   * without an intervention entry for each (the caller writes one for all).
   * Returns how many.
   */
  setAside(channelId: string, since: string): number {
    const result = this.db
      .query("UPDATE messages SET deleted_at = $now, deleted_by = 'user' WHERE channel_id = $channelId AND created_at >= $since AND deleted_at IS NULL")
      .run({ channelId, since, now: new Date().toISOString() });
    this.messagesChanged(channelId);
    return result.changes;
  }

  /**
   * A regeneration: the old reply leaves the chat, replaced by the new
   * turn `turnId`, and is kept as an alternate of it.
   */
  supersede(ids: string[], turnId: string): void {
    if (ids.length === 0) return;
    const messages = ids.map((id) => this.getLiveMessage(id));
    for (const message of messages) this.summaries.messageChanging(message, true);
    const mark = this.db.query("UPDATE messages SET superseded_by = $turnId WHERE id = $id");
    // The replies these replaced become alternates of the new one too.
    const inherit = this.db.query("UPDATE messages SET superseded_by = $turnId WHERE channel_id = $channelId AND superseded_by = $old");
    this.db.transaction(() => {
      for (const message of messages) mark.run({ id: message.id, turnId });
      for (const old of new Set(messages.map((m) => m.turnId).filter((t) => t !== null))) {
        inherit.run({ turnId, channelId: messages[0]!.channelId, old });
      }
    })();
    this.messagesChanged(messages[0]!.channelId);
  }

  /**
   * Everything that happened to a message: every version of its text, and
   * the replies it replaced, including ones those replaced in turn.
   */
  history(id: string): MessageHistory {
    const message = this.getMessage(id);
    const revisions = (
      this.db
        .query("SELECT content, author, created_at FROM message_revisions WHERE message_id = $id ORDER BY id")
        .all({ id }) as { content: string; author: Author; created_at: string }[]
    ).map((r): Revision => ({ content: r.content, author: r.author, createdAt: r.created_at }));
    const alternates: Message[] = [];
    const seen = new Set<string>();
    let turns = message.turnId ? [message.turnId] : [];
    while (turns.length > 0) {
      const next: string[] = [];
      for (const turnId of turns) {
        if (seen.has(turnId)) continue;
        seen.add(turnId);
        const rows = this.db
          .query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.superseded_by = $turnId ORDER BY m.seq`)
          .all({ channelId: message.channelId, turnId }) as MessageRow[];
        for (const row of rows) {
          alternates.push(toMessage(row));
          if (row.turn_id) next.push(row.turn_id);
        }
      }
      turns = next;
    }
    alternates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { message, revisions, alternates };
  }

  // -------------------------------------------------------------- branches
  //
  // The chat is a tree, NovelAI-style. Going back to a message sets aside
  // everything after it as a branch, which you can return to later. Nothing
  // is copied or rewritten: a branch's messages are marked in
  // `superseded_by` with `branch:<fork message id>:<random>`, so they leave
  // the chat (and every prompt) the way a regenerated reply does, and come
  // back by clearing the mark. A branch shows wherever its fork message is
  // in the chat; when the fork itself is set aside (or regenerated), so are
  // the branches after it, until it comes back.

  /**
   * Set aside every message after `messageId` as a branch. Returns the
   * branch, or `null` if nothing came after it.
   */
  branchFrom(messageId: string): Branch | null {
    const fork = this.getLiveMessage(messageId);
    const after = this.liveAfter(fork);
    if (after.length === 0) return null;
    const id = `${BRANCH}${fork.id}:${crypto.randomUUID()}`;
    this.db.transaction(() => {
      this.shelve(after, id);
      if (after.some((m) => m.author === "kinwriter")) {
        this.interventions.add({
          kind: "branch",
          summary: `The user went back to an earlier point in #${this.getChannel(fork.channelId).name}. The ${after.length} message${after.length === 1 ? "" : "s"} after it are kept as a branch they can return to.`,
          channelId: fork.channelId,
          messageId: fork.id,
        });
      }
    })();
    this.messagesChanged(fork.channelId);
    return this.branch(id);
  }

  /**
   * Go to a branch: what comes after its fork now is set aside as a branch
   * in turn, and the branch's messages come back. Returns the branch that
   * was set aside, if anything came after the fork.
   */
  switchBranch(branchId: string): Branch | null {
    const target = this.branch(branchId); // throws NotFoundError
    // From the channel's start, everything in the chat now is set aside.
    const fromStart = target.forkId === CHANNEL_START;
    const fork = fromStart ? null : this.getMessage(target.forkId);
    if (fork && (fork.deletedAt || fork.supersededBy)) {
      throw new ValidationError("That branch starts from a message that isn't in the chat now.");
    }
    const channelId = target.channelId;
    const after = fork ? this.liveAfter(fork) : this.getMessages(channelId);
    const shelvedId = after.length > 0 ? `${BRANCH}${target.forkId}:${crypto.randomUUID()}` : null;
    this.db.transaction(() => {
      if (shelvedId) this.shelve(after, shelvedId);
      this.db.query("UPDATE messages SET superseded_by = NULL WHERE superseded_by = $id").run({ id: branchId });
      if (after.some((m) => m.author === "kinwriter") || target.messages.some((m) => m.author === "kinwriter")) {
        this.interventions.add({
          kind: "branch",
          summary: `The user switched #${this.getChannel(channelId).name} to another branch of the conversation: ${target.count} message${target.count === 1 ? "" : "s"} came back${after.length > 0 ? `, and the ${after.length} that were there are kept as a branch` : ""}.`,
          channelId,
          messageId: fork?.id ?? null,
        });
      }
    })();
    this.messagesChanged(channelId);
    return shelvedId ? this.branch(shelvedId) : null;
  }

  /** One branch, with its messages, oldest first. Throws `NotFoundError` if there's no such branch. */
  branch(branchId: string): Branch {
    const forkId = forkOf(branchId);
    const rows = forkId
      ? (this.db.query(`${SELECT_MESSAGES} WHERE m.superseded_by = $branchId ORDER BY m.seq`).all({ branchId }) as MessageRow[])
      : [];
    if (rows.length === 0) throw new NotFoundError("branch");
    const messages = rows.map(toMessage);
    return { id: branchId, forkId: forkId!, channelId: messages[0]!.channelId, count: messages.length, messages };
  }

  /**
   * The branches you can go to in a channel: those whose fork message is in
   * the chat (or that start at the channel's start), oldest first (by their first message). Without their messages,
   * apart from the first and last.
   */
  branches(channelId: string): BranchSummary[] {
    const rows = this.db
      .query(
        `SELECT superseded_by AS id, COUNT(*) AS n, MIN(seq) AS first, MAX(seq) AS last FROM messages
          WHERE channel_id = $channelId AND superseded_by LIKE '${BRANCH}%' AND deleted_at IS NULL
          GROUP BY superseded_by ORDER BY first`,
      )
      .all({ channelId }) as { id: string; n: number; first: number; last: number }[];
    const live = new Set(this.getMessages(channelId).map((m) => m.id));
    const at = (seq: number) => toMessage(this.db.query(`${SELECT_MESSAGES} WHERE m.seq = $seq`).get({ seq }) as MessageRow);
    return rows
      .filter((r) => forkOf(r.id) === CHANNEL_START || live.has(forkOf(r.id) ?? ""))
      .map((r) => ({ id: r.id, forkId: forkOf(r.id)!, count: r.n, first: at(r.first), last: at(r.last) }));
  }

  /**
   * Go back to an earlier version of a reply (one a regeneration replaced):
   * it comes back, and the reply that's there now joins its alternates.
   * Anything written after that reply is set aside as a branch first, and
   * returns if you go back to the reply it followed.
   */
  useAlternate(id: string): Message[] {
    const chosen = this.getMessage(id);
    const replacedBy = chosen.supersededBy;
    if (chosen.deletedAt || !replacedBy || forkOf(replacedBy)) {
      throw new ValidationError("Only a reply that a regeneration replaced can be brought back.");
    }
    // The reply in the chat now: follow the regenerations to it.
    let live: Message[] = [];
    const seen = new Set<string>();
    for (let turnId: string | undefined = replacedBy; turnId && !seen.has(turnId); ) {
      seen.add(turnId);
      const rows: Message[] = (
        this.db.query(`${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND m.turn_id = $turnId ORDER BY m.seq`).all({
          channelId: chosen.channelId,
          turnId,
        }) as MessageRow[]
      ).map(toMessage);
      live = rows.filter((m) => !m.deletedAt && !m.supersededBy);
      if (live.length > 0) break;
      const next: string | undefined = rows.find((m) => !m.deletedAt)?.supersededBy;
      turnId = next && !forkOf(next) ? next : undefined;
    }
    if (live.length === 0) throw new ValidationError("The reply that replaced this one isn't in the chat now.");
    this.branchFrom(live.at(-1)!.id);
    // A reply from before turn ids: give it one, so the others can point at it.
    const turnId = chosen.turnId ?? crypto.randomUUID();
    if (!chosen.turnId) this.db.query("UPDATE messages SET turn_id = $turnId WHERE id = $id").run({ id, turnId });
    const group = [...live, ...this.history(live[0]!.id).alternates];
    for (const message of live) this.summaries.messageChanging(message, true);
    this.db.transaction(() => {
      const mark = this.db.query("UPDATE messages SET superseded_by = $to WHERE id = $id");
      for (const message of group) {
        const ours = message.id === id || (chosen.turnId !== null && message.turnId === chosen.turnId);
        mark.run({ id: message.id, to: ours ? null : turnId });
      }
      this.interventions.add({
        kind: "regenerate",
        summary: `The user went back to an earlier version of your reply in #${this.getChannel(chosen.channelId).name}. The one that replaced it is kept as an alternate.`,
        channelId: chosen.channelId,
        messageId: id,
      });
    })();
    this.messagesChanged(chosen.channelId);
    return group.filter((m) => m.id === id || (chosen.turnId !== null && m.turnId === chosen.turnId)).map((m) => this.getMessage(m.id));
  }

  /** The messages in the chat after one, oldest first. */
  private liveAfter(message: Message): Message[] {
    const rows = this.db
      .query(
        `${SELECT_MESSAGES} WHERE m.channel_id = $channelId AND ${LIVE}
           AND m.seq > (SELECT seq FROM messages WHERE id = $id) ORDER BY m.seq`,
      )
      .all({ channelId: message.channelId, id: message.id }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * A message leaving the chat for good: the branches after it now follow
   * the message before it, so they can still be reached. If it was the
   * first, they start at the channel's start (`CHANNEL_START`).
   */
  private rehomeBranches(message: Message): void {
    const previous = this.db
      .query(`SELECT m.id FROM messages m WHERE m.channel_id = $channelId AND ${LIVE} AND m.seq < (SELECT seq FROM messages WHERE id = $id) ORDER BY m.seq DESC LIMIT 1`)
      .get({ channelId: message.channelId, id: message.id }) as { id: string } | null;
    const from = `${BRANCH}${message.id}:`;
    this.db
      .query("UPDATE messages SET superseded_by = $to || substr(superseded_by, $cut) WHERE channel_id = $channelId AND substr(superseded_by, 1, $len) = $from")
      .run({ to: `${BRANCH}${previous?.id ?? CHANNEL_START}:`, cut: from.length + 1, len: from.length, from, channelId: message.channelId });
  }

  /** Mark messages as part of a branch (in a transaction of the caller's). */
  private shelve(messages: Message[], branchId: string): void {
    for (const message of messages) this.summaries.messageChanging(message, true);
    const mark = this.db.query("UPDATE messages SET superseded_by = $branchId WHERE id = $id");
    for (const message of messages) mark.run({ id: message.id, branchId });
  }

  /**
   * Attach notebook entries to a message, so they're sent to your kinwriter
   * with it. Entries already attached are skipped.
   */
  attach(messageId: string, entryIds: string[]): Message {
    const insert = this.db.query(
      "INSERT OR IGNORE INTO message_attachments (message_id, entry_id) VALUES ($messageId, $entryId)",
    );
    this.db.transaction(() => {
      for (const entryId of entryIds) insert.run({ messageId, entryId });
    })();
    return this.getMessage(messageId);
  }

  /**
   * Approve or deny one of your kinwriter's proposals. Approving carries it
   * out: for a channel deletion, the channel is deleted (if it still exists).
   */
  resolveProposal(id: string, approve: boolean): void {
    this.db.transaction(() => {
      const proposal = this.inbox.resolveProposal(id, approve ? "approved" : "denied");
      if (approve && proposal.kind === "delete_channel") {
        // As if you'd deleted it yourself: its scratchpads and library limits go with it.
        if (this.hasChannel(proposal.targetId!)) this.deleteChannel(proposal.targetId!);
      }
      // A new name they asked for: their display name, and their self-notes' header, which is built from it.
      if (approve && proposal.kind === "rename" && proposal.targetName) {
        this.updateSettings({ kinwriterName: proposal.targetName });
      }
    })();
  }

  /**
   * Clear a channel: every message leaves the chat, as tombstones (see
   * `deleteMessage`). The channel itself stays.
   */
  clearMessages(channelId: string, by: Author = "user"): void {
    const channel = this.getChannel(channelId); // throws NotFoundError for an unknown channel
    const hadKinwriter = this.getMessages(channelId).some((m) => m.author === "kinwriter");
    this.db.transaction(() => {
      this.db
        .query("UPDATE messages SET deleted_at = $now, deleted_by = $by WHERE channel_id = $channelId AND deleted_at IS NULL AND superseded_by IS NULL")
        .run({ channelId, now: new Date().toISOString(), by });
      if (by === "user" && hadKinwriter) {
        this.interventions.add({ kind: "clear", summary: `The user cleared every message in #${channel.name}.`, channelId });
      }
    })();
    this.summaries.clear(channelId);
    this.messagesChanged(channelId);
  }
}

/** Set by a fresh start (src/fresh.ts): the app asks you to make your new kinwriter first. */
export const SETUP_PENDING = "setup.pending";

/** A group channel or DM: kept by several kinwriters, under the same id (src/groups.ts). */
export function isShared(channel: Pick<Channel, "kind">): boolean {
  return channel.kind === "group" || channel.kind === "dm";
}

/** The start of a message, on one line, for the intervention log. */
function snippet(text: string, length = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
