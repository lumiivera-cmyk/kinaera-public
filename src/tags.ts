/**
 * Tag files (design/kinwriter-generation/spec.md, "Tag files"): one
 * Markdown file per option a new kinwriter can be made from, under
 * `kinwriter-tags/<category>/<slug>.md`.
 *
 * The header drives the picker and the details page (`id`, `category`,
 * `label`, `blurb`, `order`, and `avoid_terms`, the words a seed must never
 * use). The body is the researched fragment, which only the generator
 * reads: its sections as `##` headings, and for platforms and influences a
 * `## Pockets` section with three to five corners, each an `###` heading
 * (a short slug), `label:` and `blurb:` lines for the Advanced section, and
 * bullets of effects for the generator.
 *
 * Nothing about a particular tag is written in code: they're read fresh
 * from the folder each time they're asked for, so adding, changing or
 * removing a file changes the picker with no code change. Only the five
 * categories, and their order, are fixed here.
 *
 * A file that doesn't load is a hard error in dev mode and a skipped tag
 * (with a warning in the log) otherwise. Check files (dev mode) says what's
 * wrong with any of them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { headerList, headerText, splitFrontmatter } from "./frontmatter.ts";

/** Where the tag files are. */
export const TAGS_DIR = resolve(import.meta.dir, "..", "kinwriter-tags");

/** The five categories, in the picker's order. */
export const CATEGORIES = [
  { id: "personality", label: "Personality", section: "Personality" },
  { id: "temperament", label: "Temperament", section: "Temperament" },
  { id: "prose", label: "Prose style", section: "Prose style" },
  { id: "inspiration", label: "Biggest influence", section: "Biggest influence" },
  { id: "social", label: "Primary social media", section: "Primary social media", subtitle: "i promise this option is interesting" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** The fragment's sections, in order. Era is only for social platforms. */
export const TAG_SECTIONS = ["Era", "Texture", "On the page", "In OOC", "Tics", "Avoid", "Tension hooks"];

export interface Pocket {
  slug: string;
  label: string;
  blurb: string;
  /** The effects, for the generator only. */
  bullets: string[];
}

export interface Tag {
  /** `category.slug`. */
  id: string;
  category: CategoryId;
  slug: string;
  label: string;
  blurb: string;
  order: number;
  avoidTerms: string[];
  /** The fragment without its Pockets section: what the generator reads. */
  fragment: string;
  /** Its `##` sections, by heading. */
  sections: Record<string, string>;
  pockets: Pocket[];
  /** The file, from the repo's root. */
  file: string;
}

/** One thing wrong with a file, for Check files and the log. */
export interface FileProblem {
  file: string;
  message: string;
}

/** Split a body into its `##` sections (in order), each with its text. */
function sections(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  for (const line of body.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) out.push({ heading: heading[1]!, text: "" });
    else if (out.length) out.at(-1)!.text += `${line}\n`;
  }
  return out.map((s) => ({ heading: s.heading, text: s.text.trim() }));
}

/** The pockets in a Pockets section. */
function parsePockets(text: string): { pockets: Pocket[]; problems: string[] } {
  const pockets: Pocket[] = [];
  const problems: string[] = [];
  let current: Pocket | null = null;
  for (const line of text.split("\n")) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = { slug: heading[1]!, label: "", blurb: "", bullets: [] };
      pockets.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^(label|blurb):\s*(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (field) current[field[1] as "label" | "blurb"] = field[2]!.trim();
    else if (bullet) current.bullets.push(bullet[1]!.trim());
    else if (line.trim() && current.bullets.length) current.bullets[current.bullets.length - 1] += ` ${line.trim()}`;
  }
  for (const p of pockets) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.slug)) problems.push(`Pocket "${p.slug}" needs a short slug: lowercase letters, numbers and dashes.`);
    if (!p.label) problems.push(`Pocket "${p.slug}" has no label.`);
    if (!p.blurb) problems.push(`Pocket "${p.slug}" has no blurb.`);
    if (!p.bullets.length) problems.push(`Pocket "${p.slug}" has no bullets.`);
  }
  if (new Set(pockets.map((p) => p.slug)).size !== pockets.length) problems.push("Two pockets have the same slug.");
  return { pockets, problems };
}

/** Read one tag file. Returns the tag (if it can be used) and everything wrong with it. */
export function parseTagFile(text: string, file: string, folder?: string): { tag: Tag | null; problems: string[] } {
  const { header, body, hasHeader } = splitFrontmatter(text);
  const problems: string[] = [];
  if (!hasHeader) return { tag: null, problems: ["It has no header (the lines between ---)."] };
  const id = headerText(header, "id");
  const category = headerText(header, "category") as CategoryId;
  const label = headerText(header, "label");
  const blurb = headerText(header, "blurb");
  for (const [field, value] of [["id", id], ["category", category], ["label", label], ["blurb", blurb]] as const) {
    if (!value) problems.push(`The header needs "${field}".`);
  }
  if (category && !CATEGORIES.some((c) => c.id === category)) problems.push(`"${category}" isn't a category. They are: ${CATEGORIES.map((c) => c.id).join(", ")}.`);
  if (folder && category && category !== folder) problems.push(`It's in ${folder}/ but says category: ${category}.`);
  const slug = id.split(".").slice(1).join(".");
  if (id && (!id.startsWith(`${category}.`) || !/^[a-z0-9][a-z0-9-]*$/.test(slug))) problems.push(`Its id should be "${category}.<slug>", like ${category}.example.`);
  const order = header.order === undefined ? 1000 : Number(header.order);
  if (header.order !== undefined && !Number.isInteger(order)) problems.push('"order" should be a whole number.');

  const parts = sections(body);
  const headings = parts.map((p) => p.heading);
  const expected = TAG_SECTIONS.filter((h) => h !== "Era" || category === "social");
  const missing = expected.filter((h) => !headings.includes(h));
  if (missing.length) problems.push(`It's missing ${missing.map((h) => `"## ${h}"`).join(", ")}.`);
  const unknown = headings.filter((h) => !TAG_SECTIONS.includes(h) && h !== "Pockets");
  if (unknown.length) problems.push(`${unknown.map((h) => `"## ${h}"`).join(", ")} isn't one of the sections (${[...TAG_SECTIONS, "Pockets"].join(", ")}).`);
  const order_ = headings.filter((h) => TAG_SECTIONS.includes(h));
  const inOrder = [...order_].sort((a, b) => TAG_SECTIONS.indexOf(a) - TAG_SECTIONS.indexOf(b));
  if (order_.join("|") !== inOrder.join("|")) problems.push(`Its sections are out of order: ${TAG_SECTIONS.join(", ")}.`);
  if (headings.includes("Pockets") && headings.at(-1) !== "Pockets") problems.push('"## Pockets" should come last.');

  const pocketText = parts.find((p) => p.heading === "Pockets")?.text ?? "";
  const { pockets, problems: pocketProblems } = parsePockets(pocketText);
  problems.push(...pocketProblems);
  if (parts.some((p) => p.heading === "Pockets") && !pockets.length) problems.push('"## Pockets" has no pockets.');

  if (!id || !label || !category || !CATEGORIES.some((c) => c.id === category)) return { tag: null, problems };
  // The fragment the generator reads: the body up to its Pockets section.
  const fragment = body.split(/^##\s+Pockets\s*$/m)[0]!.trim();
  return {
    tag: {
      id,
      category,
      slug,
      label,
      blurb,
      order,
      avoidTerms: headerList(header, "avoid_terms"),
      fragment,
      sections: Object.fromEntries(parts.map((p) => [p.heading, p.text])),
      pockets: pockets.filter((p) => p.label && p.blurb && p.bullets.length),
      file,
    },
    problems,
  };
}

/** Every tag file, read now, with any problems. */
export function readTagFiles(dir: string = TAGS_DIR): { tags: Tag[]; problems: FileProblem[] } {
  const tags: Tag[] = [];
  const problems: FileProblem[] = [];
  if (!existsSync(dir)) return { tags, problems };
  const root = resolve(dir, "..");
  for (const category of CATEGORIES) {
    const folder = join(dir, category.id);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort()) {
      const path = join(folder, name);
      const file = relative(root, path);
      let result: { tag: Tag | null; problems: string[] };
      try {
        result = parseTagFile(readFileSync(path, "utf8"), file, category.id);
      } catch (error) {
        result = { tag: null, problems: [`It couldn't be read: ${(error as Error).message}`] };
      }
      for (const message of result.problems) problems.push({ file, message });
      if (result.tag) {
        if (tags.some((t) => t.id === result.tag!.id)) problems.push({ file, message: `Another file already has the id ${result.tag.id}.` });
        else if (`${result.tag.slug}.md` !== name) problems.push({ file, message: `Its id's slug (${result.tag.slug}) should match its file name.` });
        tags.push(result.tag);
      }
    }
  }
  return { tags, problems };
}

/**
 * The tags to use. A file with a problem stops the app in dev mode (`strict`),
 * so it's fixed before a user meets it; otherwise it's skipped, with a warning.
 */
export function loadTags(options: { strict?: boolean; dir?: string } = {}): Tag[] {
  const { tags, problems } = readTagFiles(options.dir);
  if (problems.length && options.strict) {
    throw new Error(`Tag files have problems:\n${problems.map((p) => `  ${p.file}: ${p.message}`).join("\n")}`);
  }
  const broken = new Set(problems.map((p) => p.file));
  for (const p of problems) console.warn(`[tags] ${p.file}: ${p.message} (skipped)`);
  return tags.filter((t) => !broken.has(t.file)).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Every avoid term, from every tag file: none may appear in any seed. */
export function allAvoidTerms(tags: Tag[]): string[] {
  return [...new Set(tags.flatMap((t) => t.avoidTerms))];
}

/** The picker's view: categories in order, each with its options, labels, blurbs and pockets (never the fragments). */
export function pickerView(tags: Tag[]) {
  return CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    subtitle: "subtitle" in c ? c.subtitle : null,
    options: tags
      .filter((t) => t.category === c.id)
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
      .map((t) => ({
        id: t.id,
        label: t.label,
        blurb: t.blurb,
        pockets: t.pockets.map((p) => ({ slug: p.slug, label: p.label, blurb: p.blurb })),
        // For the details page (social media): its era and tics.
        era: t.sections.Era ?? null,
        tics: (t.sections.Tics ?? "")
          .split("\n")
          .map((l) => l.match(/^\s*[-*]\s+(.*)$/)?.[1])
          .filter((l): l is string => Boolean(l))
          .map((l) => l.replace(/\*\*/g, "")),
        file: t.file,
      })),
  })).filter((c) => c.options.length > 0);
}
