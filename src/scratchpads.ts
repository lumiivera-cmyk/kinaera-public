/**
 * Scratchpads: freeform notes for a storyline, kept out of the notebook.
 * Details, where everyone is standing, secrets, ideas, notes on a character
 * or a place: things worth writing down that aren't lore (yet).
 *
 * Each story channel (`"rp"`) has three:
 *
 *   - **shared**: yours and your kinwriter's. You both read and write it,
 *     and it's in their prompt in that channel.
 *   - **user**: yours alone. It's never in their prompt, and no tool
 *     reads it.
 *   - **kinwriter**: theirs alone. It's in their prompt in that channel; you
 *     don't see it (the prompt preview shows that it's there, not what it
 *     says), the tool log never keeps its text, and only the developer
 *     panel opens it (disclosed to them, `developer` in defaults/standing.md).
 *
 * Every write keeps the version before it, so one change (yours or theirs)
 * can be undone. Each write also counts up the pad's `rev`, and a write can
 * name the rev it started from (`base`): if the pad changed since, it's
 * refused, so neither of you writes over the other without seeing it.
 *
 * **Saving to the notebook** (`toNotebook`): a passage of a pad becomes a
 * new entry, or is added to a field of an existing one, with the
 * notebook's own permissions (a change your kinwriter may only suggest is a
 * suggestion). By default it then leaves the pad. A new entry from their
 * private pad starts hidden from you, like the note it came from.
 *
 * Kept in app_state, one value per pad (`scratchpad:<channel>:<pad>`), as
 * JSON. Deleting the channel deletes its pads.
 */

import type { Database } from "bun:sqlite";
import { ValidationError } from "./errors.ts";
import { ENTRY_TEMPLATES } from "./notebook.ts";
import type { Author, Channel, EntryKind } from "./types.ts";
import type { Store } from "./store.ts";

export type PadName = "shared" | "user" | "kinwriter";
export const PAD_NAMES: PadName[] = ["shared", "user", "kinwriter"];

/** Longest a pad can be, in characters (about 2,000 words). */
export const PAD_LIMIT = 12_000;

export interface PadVersion {
  text: string;
  /** Who wrote it: you, or your kinwriter. */
  by: Author;
  at: string;
}

export interface Pad {
  text: string;
  /** Who last changed it, and when (null: never written). */
  by: Author | null;
  at: string | null;
  /** How many times it's been changed: the version a write starts from. */
  rev: number;
  /** The version before the last change, for undo. */
  previous: PadVersion | null;
}

/** Thrown when a write started from a version that's no longer the latest. */
export class PadChangedError extends Error {
  constructor(readonly pad: Pad) {
    super("The scratchpad changed since you opened it.");
    this.name = "PadChangedError";
  }
}

const key = (channelId: string, pad: PadName) => `scratchpad:${channelId}:${pad}`;
const EMPTY: Pad = { text: "", by: null, at: null, rev: 0, previous: null };

/** Whether a channel has scratchpads: story channels only. */
export function hasScratchpads(channel: Pick<Channel, "kind">): boolean {
  return channel.kind === "rp";
}

export function getPad(store: Store, channelId: string, pad: PadName): Pad {
  const value = store.appState.get(key(channelId, pad));
  return value ? { ...EMPTY, ...(JSON.parse(value) as Partial<Pad>) } : { ...EMPTY };
}

/**
 * Write a pad's text in full. `base` is the `rev` of the version the writer
 * started from (0: a pad never written); leave it out to write regardless.
 * Writing the same text again changes nothing.
 */
export function writePad(
  store: Store,
  channelId: string,
  pad: PadName,
  text: string,
  by: Author,
  base?: number,
  now: Date = new Date(),
): Pad {
  if (typeof text !== "string") throw new ValidationError("A scratchpad's text must be text.");
  const clean = text.replace(/\s+$/, "");
  if (clean.length > PAD_LIMIT) {
    throw new ValidationError(`That's too long for a scratchpad (${PAD_LIMIT.toLocaleString("en")} characters at most). Tidy it up, or move what's settled into the notebook.`);
  }
  const current = getPad(store, channelId, pad);
  if (base !== undefined && base !== current.rev) throw new PadChangedError(current);
  if (clean === current.text) return current;
  const previous = current.at ? { text: current.text, by: current.by!, at: current.at } : null;
  const next: Pad = { text: clean, by, at: now.toISOString(), rev: current.rev + 1, previous };
  store.appState.set(key(channelId, pad), JSON.stringify(next));
  return next;
}

/** Add a note at the end, on a line of its own. */
export function appendToPad(store: Store, channelId: string, pad: PadName, note: string, by: Author, now: Date = new Date()): Pad {
  const text = note.trim();
  if (!text) throw new ValidationError("There's nothing to add.");
  const current = getPad(store, channelId, pad).text;
  return writePad(store, channelId, pad, current ? `${current}\n${text}` : text, by, undefined, now);
}

/** Put back the version before the last change (itself undoable: undo twice to redo). */
export function undoPad(store: Store, channelId: string, pad: PadName, by: Author, now: Date = new Date()): Pad {
  const current = getPad(store, channelId, pad);
  if (!current.previous) throw new ValidationError("There's nothing to undo.");
  return writePad(store, channelId, pad, current.previous.text, by, undefined, now);
}

/** Forget a channel's pads (the channel is being deleted). */
export function deletePads(db: Database, channelId: string): void {
  for (const pad of PAD_NAMES) db.query("DELETE FROM app_state WHERE key = $key").run({ key: key(channelId, pad) });
}

/** Whether they've been told about scratchpads (app_state): once. */
export const PADS_INTRODUCED = "scratchpad.introduced";

// ---------------------------------------------------------- to the notebook

export interface ToNotebook {
  /** The text to save: an exact passage of the pad. */
  passage: string;
  /** Where it starts in the pad, when the same text is there more than once (the selection, from the app). */
  index?: number;
  /** An existing entry to add it to... */
  entryId?: string;
  /** ...or a new one. */
  name?: string;
  kind?: EntryKind;
  /** The field it goes in (added to the end of what's there). Default: "Details" for lore, "Background" for a character. */
  field?: string;
  /** A new entry: pin it to this channel. */
  pin?: boolean;
  /** Keep it in the pad too (default: it moves). */
  keep?: boolean;
}

export interface SavedToNotebook {
  entry: { id: string; name: string; kind: EntryKind };
  created: boolean;
  /** Only a suggestion, for the entry's owner to review. */
  suggested: boolean;
  pinned: boolean;
  pad: Pad;
}

/** Whether two entry names are the same: ignoring case, punctuation and a leading "the" (as `sameEntryName` in src/tools.ts). */
function sameName(a: string, b: string): boolean {
  const key = (name: string) => name.toLowerCase().replace(/^\s*the\s+/, "").replace(/[^\p{L}\p{N}]+/gu, "");
  return key(a) !== "" && key(a) === key(b);
}

/** Save a passage of a pad to the notebook, as `actor`, and (unless kept) take it out of the pad. */
export function toNotebook(store: Store, channelId: string, pad: PadName, actor: Author, input: ToNotebook): SavedToNotebook {
  const passage = input.passage.trim();
  if (!passage) throw new ValidationError("Choose the text to save first.");
  const current = getPad(store, channelId, pad);
  // Where it is: at the index given, if it's there, or its only (or first) place.
  const at = input.index !== undefined && current.text.slice(input.index, input.index + input.passage.length) === input.passage
    ? input.index
    : current.text.indexOf(input.passage);
  if (at < 0) throw new ValidationError("That text isn't in the scratchpad (it may have changed). Choose it again.");

  const notebook = store.notebook;
  let entry;
  let created = false;
  let suggested = false;
  if (input.entryId) {
    entry = notebook.getEntry(actor, input.entryId);
    const label = (input.field?.trim() || defaultField(entry.kind)).slice(0, 60);
    const fields = entry.fields.map((f) => ({ ...f }));
    const field = fields.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (field) field.value = field.value.trim() ? `${field.value.trimEnd()}\n${passage}` : passage;
    else fields.push({ label, value: passage });
    const outcome = notebook.editEntry(actor, entry.id, { fields });
    suggested = "suggestion" in outcome;
  } else {
    const name = input.name?.trim() ?? "";
    if (!name) throw new ValidationError("Give the new entry a name, or choose one to add to.");
    const existing = notebook.listEntries(actor).find((e) => sameName(e.name, name));
    if (existing) throw new ValidationError(`There's already an entry called "${existing.name}". Add to it instead, or give the new one a name that tells them apart.`);
    const kind = input.kind ?? "lore";
    const label = (input.field?.trim() || defaultField(kind)).slice(0, 60);
    const fields = ENTRY_TEMPLATES[kind].map((l) => ({ label: l, value: "" }));
    const field = fields.find((f) => f.label.toLowerCase() === label.toLowerCase());
    if (field) field.value = passage;
    else fields.push({ label, value: passage });
    entry = notebook.createEntry(actor, {
      kind,
      name,
      fields,
      // Theirs from their private pad stays a secret until they reveal it.
      ...(actor === "friend" && pad === "kinwriter" ? { visibility: "hidden" } : {}),
    });
    created = true;
  }
  const pinned = created && input.pin === true;
  if (pinned) notebook.pin(actor, channelId, entry.id);

  let next = current;
  if (!input.keep) {
    const before = current.text.slice(0, at).replace(/[ \t]+$/, "");
    let after = current.text.slice(at + input.passage.length).replace(/^[ \t]+/, "");
    // A whole line (or lines) taken out: its line break goes with it.
    if ((before === "" || before.endsWith("\n")) && after.startsWith("\n")) after = after.slice(1);
    next = writePad(store, channelId, pad, `${before}${after}`.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, ""), actor);
  }
  return { entry: { id: entry.id, name: entry.name, kind: entry.kind }, created, suggested, pinned, pad: next };
}

function defaultField(kind: EntryKind): string {
  return kind === "character" ? "Background" : "Details";
}

// ------------------------------------------------------------- merging

/**
 * Two people's changes to the same text, both kept: a line-by-line
 * three-way merge, like a shared document. `base` is what both started
 * from; `mine` and `theirs` are each one's version. Changes to different
 * lines are both applied. Where both changed the same lines differently,
 * `mine` comes first, then whatever of `theirs` isn't already in it, so
 * nothing either wrote is lost.
 */
export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const b = base.split("\n");
  const hunks = [...lineHunks(b, mine.split("\n"), "m"), ...lineHunks(b, theirs.split("\n"), "t")].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  while (i < hunks.length) {
    // A group: hunks whose base lines overlap (or that insert at the same place).
    const group = [hunks[i]!];
    let start = hunks[i]!.start;
    let end = hunks[i]!.end;
    i++;
    while (i < hunks.length) {
      const h = hunks[i]!;
      const overlaps = h.start < end || (h.start === end && h.start === h.end && start === end);
      if (!overlaps) break;
      group.push(h);
      end = Math.max(end, h.end);
      i++;
    }
    out.push(...b.slice(pos, start));
    const sides = new Set(group.map((h) => h.side));
    if (sides.size === 1) {
      out.push(...apply(b, start, end, group));
    } else {
      const m = apply(b, start, end, group.filter((h) => h.side === "m"));
      const t = apply(b, start, end, group.filter((h) => h.side === "t"));
      const seen = new Set(m);
      out.push(...m, ...(m.join("\n") === t.join("\n") ? [] : t.filter((line) => !seen.has(line))));
    }
    pos = end;
  }
  out.push(...b.slice(pos));
  return out.join("\n");
}

interface Hunk {
  /** Base lines [start, end) became `lines`. */
  start: number;
  end: number;
  lines: string[];
  side: "m" | "t";
}

/** Base lines [start, end) with these (non-overlapping) hunks applied. */
function apply(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.start), ...h.lines);
    pos = Math.max(pos, h.end);
  }
  out.push(...base.slice(pos, end));
  return out;
}

/** How `next` differs from `base`, line by line (longest common subsequence). */
function lineHunks(base: string[], next: string[], side: "m" | "t"): Hunk[] {
  const n = base.length;
  const m = next.length;
  // lcs[i][j]: the longest common run of base[i..] and next[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = base[i] === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      open ??= { start: i, end: i, lines: [], side };
      open.lines.push(next[j]!);
      j++;
    } else {
      open ??= { start: i, end: i, lines: [], side };
      open.end = i + 1;
      i++;
    }
  }
  close();
  return hunks;
}
