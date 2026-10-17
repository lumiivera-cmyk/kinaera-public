/**
 * Seeds: the short profile every kinwriter begins as
 * (design/kinwriter-generation/spec.md, "Seed format").
 *
 * A seed is a Markdown file with a header for code and a body for the
 * kinwriter. Code only ever reads the header; the body goes to the
 * kinwriter. The body always has the same nine headings, in this order, so
 * they can be checked by their exact text:
 *
 *   ## Who they are   ## Wants          ## Off the page
 *   ## In OOC         ## On the page    ## Voice
 *   ## Contradictions ## Leanings       ## Left open
 *
 * Version 1 seeds (seven headings, with Tension, and no Wants or Off the
 * page) still read and check against their own headings.
 *
 * Defaults are hand-written seeds (kinwriter-defaults/). Generated ones come
 * from one model call (src/generator.ts). After the preview, nothing in the
 * app can tell them apart: Accept makes a new kinwriter, keeps the seed as
 * it was (read-only, `SeedArchive`), and starts their self-notes (their
 * identity, src/identity.ts) as a copy of its body.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { headerList, headerText, markdownSections, splitFrontmatter, writeFrontmatter, type Header } from "./frontmatter.ts";

/** The nine headings, in order. */
export const SEED_HEADINGS = ["Who they are", "Wants", "Off the page", "In OOC", "On the page", "Voice", "Contradictions", "Leanings", "Left open"] as const;

/** Version 1's seven headings, for seeds made before version 2. */
export const SEED_HEADINGS_V1 = ["Who they are", "On the page", "In OOC", "Voice", "Tension", "Leanings", "Left open"] as const;

/** The format's version, for future migrations. */
export const SEED_VERSION = 2;

/** How long a seed's body may be, in words. */
export const SEED_WORDS = { min: 350, max: 750 };

/** Version 1's length. */
export const SEED_WORDS_V1 = { min: 250, max: 600 };

/** The headings a seed of this version has. */
export function seedHeadings(version: number = SEED_VERSION): readonly string[] {
  return version === 1 ? SEED_HEADINGS_V1 : SEED_HEADINGS;
}

/** The words that say how often a tic shows up. Every Voice bullet has one. */
export const DOSAGE_WORDS = ["rarely", "occasionally", "regularly", "often"];

export type SeedSource = "default" | "generated" | "prompted";

export interface SeedHeader {
  id: string;
  name: string;
  pronouns: string;
  source: SeedSource;
  /** The final tags, after random fill (`category.slug`). */
  tags: string[];
  /** Which tags and pockets chance picked. */
  rolled: string[];
  /** Every pocket, chosen or rolled (`category.slug#pocket`). */
  pockets: string[];
  /** The model that generated it ("" for defaults). */
  model: string;
  created: string;
  seed_version: number;
  /** Set when the user edits it in the preview. */
  user_edited?: boolean;
  /** Defaults only: one line for their card in the picker. */
  tagline?: string;
}

export interface Seed {
  header: SeedHeader;
  body: string;
}

const SOURCES: SeedSource[] = ["default", "generated", "prompted"];

/** Read a seed file. Missing fields are empty; `validateSeed` says what's wrong. */
export function parseSeed(text: string): Seed {
  const { header, body } = splitFrontmatter(text);
  const source = headerText(header, "source") as SeedSource;
  const version = Number(header.seed_version);
  const seed: Seed = {
    header: {
      id: headerText(header, "id"),
      name: headerText(header, "name"),
      pronouns: headerText(header, "pronouns"),
      source: SOURCES.includes(source) ? source : "generated",
      tags: headerList(header, "tags"),
      rolled: headerList(header, "rolled"),
      pockets: headerList(header, "pockets"),
      model: headerText(header, "model"),
      created: headerText(header, "created"),
      seed_version: Number.isInteger(version) && version > 0 ? version : SEED_VERSION,
    },
    body,
  };
  if (header.user_edited === true) seed.header.user_edited = true;
  if (headerText(header, "tagline")) seed.header.tagline = headerText(header, "tagline");
  return seed;
}

/** Write a seed back as a file, fields in the spec's order. */
export function writeSeed(seed: Seed): string {
  const h = seed.header;
  const header: Header = {
    id: h.id,
    name: h.name,
    pronouns: h.pronouns,
    source: h.source,
    ...(h.tagline ? { tagline: h.tagline } : {}),
    tags: h.tags,
    rolled: h.rolled,
    pockets: h.pockets,
    model: h.model,
    created: h.created,
    seed_version: h.seed_version,
    ...(h.user_edited ? { user_edited: true } : {}),
  };
  return writeFrontmatter(header, seed.body);
}

// ------------------------------------------------------------ the body

/** The body's `##` sections, in the order they're written. */
export const seedSections = markdownSections;

/** One section's text ("" if it isn't there). */
export function seedSection(body: string, heading: string): string {
  return seedSections(body).find((s) => s.heading === heading)?.text ?? "";
}

/** A section's bullets, each with the lines that continue it. */
export function bullets(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) items.push(bullet[1]!);
    else if (items.length && line.trim()) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** How many words the body has under its headings (the headings themselves don't count). */
export function seedWordCount(body: string): number {
  return seedSections(body)
    .map((s) => s.text.replace(/^\s*[-*]\s+/gm, " "))
    .join(" ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Whether the headings are this version's, in order, with exact text. A readable problem, or null. */
export function checkHeadings(body: string, version: number = SEED_VERSION): string | null {
  const found = seedSections(body).map((s) => s.heading);
  const expected = [...seedHeadings(version)];
  if (found.length === expected.length && found.every((h, i) => h === expected[i])) return null;
  const missing = expected.filter((h) => !found.includes(h));
  if (missing.length) return `It needs every heading: missing "## ${missing.join('", "## ')}".`;
  const extra = found.filter((h) => !(expected as string[]).includes(h));
  if (extra.length) return `"## ${extra[0]}" isn't one of the ${expected.length} headings. They are: ${expected.join(", ")}.`;
  if (found.length !== expected.length) return "Each heading should appear once.";
  return `The headings are out of order. They go: ${expected.join(", ")}.`;
}

/** A whole-word (or whole-phrase) match, ignoring case. */
export function containsTerm(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s-]+");
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** One failed check: which, and in words. */
export interface SeedProblem {
  check: "name" | "pronouns" | "headings" | "length" | "avoid" | "left-open" | "voice";
  message: string;
}

/**
 * Every check a generated seed must pass before you see it (spec,
 * "Validation"). `avoidTerms` are every tag file's `avoid_terms`. With
 * `wordCount: false` (an edit you made), the length isn't checked.
 */
export function validateSeed(
  seed: { header: Pick<SeedHeader, "name" | "pronouns"> & { seed_version?: number }; body: string },
  options: { avoidTerms?: string[]; wordCount?: boolean; words?: { min: number; max: number } } = {},
): SeedProblem[] {
  const problems: SeedProblem[] = [];
  if (!seed.header.name.trim()) problems.push({ check: "name", message: "It has no name." });
  if (!seed.header.pronouns.trim()) problems.push({ check: "pronouns", message: "It has no pronouns." });
  const version = seed.header.seed_version ?? SEED_VERSION;
  const headings = checkHeadings(seed.body, version);
  if (headings) problems.push({ check: "headings", message: headings });
  if (options.wordCount !== false) {
    const words = options.words ?? (version === 1 ? SEED_WORDS_V1 : SEED_WORDS);
    const count = seedWordCount(seed.body);
    if (count < words.min || count > words.max) problems.push({ check: "length", message: `It's ${count} words; it should be ${words.min} to ${words.max}.` });
  }
  const text = `${seed.header.name}\n${seed.body}`;
  const found = [...new Set((options.avoidTerms ?? []).filter((term) => containsTerm(text, term)))];
  if (found.length) problems.push({ check: "avoid", message: `It names something it shouldn't: ${found.map((t) => `"${t}"`).join(", ")}.` });
  if (!headings) {
    const open = bullets(seedSection(seed.body, "Left open")).length;
    if (open < 2 || open > 3) problems.push({ check: "left-open", message: `"Left open" has ${open} bullet${open === 1 ? "" : "s"}; it should have 2 or 3.` });
    const voice = bullets(seedSection(seed.body, "Voice"));
    const bare = voice.filter((b) => !DOSAGE_WORDS.some((word) => containsTerm(b, word)));
    if (voice.length === 0) problems.push({ check: "voice", message: '"Voice" has no bullets.' });
    else if (bare.length) {
      problems.push({ check: "voice", message: `Every "Voice" bullet needs one of ${DOSAGE_WORDS.join(", ")}: "${bare[0]!.slice(0, 60)}" has none.` });
    }
  }
  return problems;
}

// ----------------------------------------------------------- defaults

/** The default kinwriters' folder: hand-written seeds that ship with the app. */
export const DEFAULTS_DIR = resolve(import.meta.dir, "..", "kinwriter-defaults");

export interface DefaultSeed {
  /** The file's name, without `.md`. */
  slug: string;
  file: string;
  seed: Seed;
}

/**
 * Every default seed, by file name. The folder ships empty, and the app
 * works with none. A file that can't be read is skipped with a warning
 * (Check files, in dev mode, says what's wrong with it).
 */
export function loadDefaultSeeds(dir: string = DEFAULTS_DIR): DefaultSeed[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort()
    .flatMap((name) => {
      const file = join(dir, name);
      try {
        const seed = parseSeed(readFileSync(file, "utf8"));
        return [{ slug: name.slice(0, -3), file, seed: { ...seed, header: { ...seed.header, source: "default" as const, model: "" } } }];
      } catch (error) {
        console.warn(`[seeds] couldn't read the default ${name}: ${(error as Error).message}`);
        return [];
      }
    });
}

// ---------------------------------------------------- their own copies

/** A seed's id before Accept gives it the kinwriter's own: `kw_` and eight hex digits. */
export function newSeedId(): string {
  return `kw_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Today, as the header writes it. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The seed a kinwriter was made from: kept as it was on Accept, and never
 * changed after (`save` only works once). Never loaded into their prompt;
 * they can read it with `read_identity_history`, and dev mode shows it
 * beside their self-notes.
 */
export class SeedArchive {
  constructor(private readonly db: Database) {}

  /** The archived `seed.md`, or null for a kinwriter made without one. */
  get(): { content: string; seed: Seed; savedAt: string } | null {
    const row = this.db.query("SELECT content, saved_at FROM seed WHERE id = 1").get() as { content: string; saved_at: string } | null;
    return row ? { content: row.content, seed: parseSeed(row.content), savedAt: row.saved_at } : null;
  }

  /** Keep the seed. Read-only from then on: a second save is refused. */
  save(seed: Seed, now: Date = new Date()): void {
    if (this.get()) throw new Error("This kinwriter's seed is already kept, and it's read-only.");
    this.db.query("INSERT INTO seed (id, content, saved_at) VALUES (1, $content, $now)").run({ content: writeSeed(seed), now: now.toISOString() });
  }
}

// -------------------------------------------------------------- Accept

/**
 * A seed as the app sends it on Accept: read, and checked the way an edit
 * is (name, pronouns and the headings, not the length, since you may
 * have edited it). Throws a readable error.
 */
export function acceptedSeed(text: unknown): Seed {
  if (typeof text !== "string" || !text.trim()) throw new Error("There's no seed to accept.");
  if (text.length > 40_000) throw new Error("That seed is far too long.");
  const seed = parseSeed(text);
  const problems = validateSeed(seed, { wordCount: false }).filter((p) => ["name", "pronouns", "headings"].includes(p.check));
  if (problems.length) throw new Error(problems.map((p) => p.message).join(" "));
  if (seed.header.name.length > 40) throw new Error("That name is too long (40 characters at most).");
  if (seed.header.pronouns.length > 40) throw new Error("Those pronouns are too long (40 characters at most).");
  if (seed.header.source === "default") seed.header.model = "";
  if (!seed.header.created) seed.header.created = today();
  return seed;
}

/**
 * A new kinwriter begins from a seed: their name and pronouns, the seed
 * kept as it was (with their own id), and their self-notes started as a
 * copy of its body. Their self-notes are private until they share them.
 */
export function beginFromSeed(
  store: { updateSettings(update: { kinwriterName?: string; kinwriterPronouns?: string }): unknown; seeds: SeedArchive; identity: { begin(identity: string, tastes: string): unknown } },
  seed: Seed,
  kinwriterId: string,
): void {
  const kept: Seed = { header: { ...seed.header, id: kinwriterId }, body: seed.body.trim() };
  store.updateSettings({ kinwriterName: kept.header.name, kinwriterPronouns: kept.header.pronouns });
  store.seeds.save(kept);
  store.identity.begin(kept.body, "");
}
