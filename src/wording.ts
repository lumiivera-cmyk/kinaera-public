/**
 * Prompt wording that lives in `defaults/`, where you can read and edit it,
 * instead of being buried in code.
 *
 * A wording file is Markdown with one `## name` section per piece of
 * text. Anything before the first section is a note for people, and isn't
 * sent. For example, `defaults/standing.md`:
 *
 *   ## history
 *
 *   The user sometimes edits or regenerates messages...
 *
 * gives `wording("standing").history`.
 *
 * Your own edits (Settings → Prompts) are kept apart from these files, in
 * `<data>/prompts.json`, and win section by section (see below).
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULTS_DIR = resolve(import.meta.dir, "..", "defaults");

/** Split a wording file's text into its sections, by name. */
export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let name: string | null = null;
  let lines: string[] = [];
  const finish = () => {
    if (name !== null) sections[name] = lines.join("\n").trim();
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      finish();
      name = heading[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  finish();
  return sections;
}

// ------------------------------------------------------------ your edits

/**
 * Your own versions of sections, edited in the app (Settings → Prompts),
 * kept in `<data>/prompts.json` as `{ file: { section: text } }`. They
 * win over `defaults/`, section by section, so an update to Kinaera that
 * changes or adds wording still reaches every section you haven't edited,
 * and `git pull` never clashes with your edits.
 */
let overridesPath: string | null = null;
let cache: { mtimeMs: number; data: Overrides } | null = null;
type Overrides = Record<string, Record<string, string>>;

/** Where your edits are kept (the hub sets this at start; tests may leave it unset). */
export function setWordingOverrides(path: string | null): void {
  overridesPath = path;
  cache = null;
}

function overrides(): Overrides {
  if (!overridesPath || !existsSync(overridesPath)) return {};
  const mtimeMs = statSync(overridesPath).mtimeMs;
  if (cache?.mtimeMs === mtimeMs) return cache.data;
  try {
    const data = JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides;
    cache = { mtimeMs, data };
    return data;
  } catch {
    console.warn(`[wording] couldn't read ${overridesPath}; using the defaults`);
    return {};
  }
}

/** The text of `defaults/<file>.md`, or "" if there's no such file. */
function defaultText(file: string): string {
  if (!/^[a-z0-9-]+$/.test(file)) return "";
  const path = join(DEFAULTS_DIR, `${file}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * The sections of `defaults/<file>.md`, with your edits in place. Read
 * fresh each time (they're small), so an edit shows up on the next turn
 * without a restart.
 */
export function wording(file: string): Record<string, string> {
  return { ...parseSections(defaultText(file)), ...(overrides()[file] ?? {}) };
}

/**
 * Fill `{name}` placeholders from `values`. Placeholders without a value
 * are left as they are (so JSON examples in the wording are safe).
 */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{([a-zA-Z][\w-]*)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** One wording file, as the Prompts screen shows it. */
export interface WordingFile {
  file: string;
  /** The note at the top of the file, for people (never sent). */
  about: string;
  sections: { name: string; text: string; defaultText: string; edited: boolean }[];
}

/** Every wording file in `defaults/` with its sections, defaults and your edits. */
export function listWording(): WordingFile[] {
  const edits = overrides();
  return readdirSync(DEFAULTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const file = f.slice(0, -3);
      const text = defaultText(file);
      const defaults = parseSections(text);
      const firstSection = text.search(/^##\s/m);
      const about = (firstSection === -1 ? text : text.slice(0, firstSection)).replace(/^#\s+.*\n/, "").trim();
      const mine = edits[file] ?? {};
      return {
        file,
        about,
        sections: Object.entries(defaults).map(([name, defaultText]) => ({
          name,
          text: mine[name] ?? defaultText,
          defaultText,
          edited: name in mine && mine[name] !== defaultText,
        })),
      };
    })
    .filter((f) => f.sections.length > 0);
}

/** Save your version of one section, or (`text` null) go back to the default. */
export function setWording(file: string, section: string, text: string | null): void {
  if (!overridesPath) throw new Error("Prompt edits can't be saved here.");
  const defaults = parseSections(defaultText(file));
  if (!(section in defaults)) throw new Error(`There's no section "${section}" in defaults/${file}.md.`);
  const data = structuredClone(overrides());
  const mine = (data[file] ??= {});
  if (text === null || text.trim() === defaults[section]!.trim()) delete mine[section];
  else mine[section] = text.trim();
  if (Object.keys(mine).length === 0) delete data[file];
  // Written whole, then swapped in, so a crash never leaves half a file.
  writeFileSync(`${overridesPath}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${overridesPath}.tmp`, overridesPath);
  cache = null;
}
