/**
 * Fetch the orientation's library example, Night of the Living Dead (1968),
 * from Wikisource, and save it in `defaults/library/` in the shape the
 * library reads best: `bun run fetch-example`.
 *
 * Why this film: it's in the public domain in the US (released in 1968
 * without a copyright notice), and the Wikisource transcript is marked
 * public domain. Not the shooting-script drafts on the Internet Archive:
 * the film being public domain doesn't clearly cover unpublished drafts.
 *
 * The transcript writes speakers as "Name: words". The library finds a
 * script's speakers by cue lines (a name in capitals on its own line, its
 * dialogue right under it), so each line is reformatted that way. Action
 * and descriptions are kept as they are.
 *
 * Run it once where you have internet (your phone, say), then commit the
 * file it writes: Kinaera ships it from then on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const API = "https://en.wikisource.org/w/api.php";
const PAGE = "Night_of_the_Living_Dead";
const OUT = resolve(import.meta.dir, "..", "defaults", "library", "night-of-the-living-dead.md");

async function wikitext(page: string): Promise<string> {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const response = await fetch(url, { headers: { "User-Agent": "Kinaera (a personal roleplay app; fetching a public-domain example once)" } });
  if (!response.ok) throw new Error(`Wikisource answered ${response.status} for ${page}.`);
  const data = (await response.json()) as { parse?: { wikitext?: string }; error?: { info?: string } };
  if (!data.parse?.wikitext) throw new Error(`No text for ${page}: ${data.error?.info ?? "unknown error"}.`);
  return data.parse.wikitext;
}

/** Wikitext to plain lines: templates, links, bold and italics, tags and comments out. */
export function plain(text: string): string {
  let out = text.replace(/<!--[\s\S]*?-->/g, "");
  // Templates, innermost first (headers, licences, page breaks).
  for (let i = 0; i < 10 && /\{\{[^{}]*\}\}/.test(out); i++) out = out.replace(/\{\{[^{}]*\}\}/g, "");
  return out
    .replace(/\[\[(?:Category|File|Image):[^\]]*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:[^\s\]]+ ([^\]]*)\]/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/'''''|'''|''/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** "Name: words" lines become a cue line and the dialogue under it; headings become scene headings. */
export function asScript(text: string): string {
  const out: string[] = [];
  for (const raw of plain(text).split("\n")) {
    const line = raw.trim();
    if (!line) {
      out.push("");
      continue;
    }
    const heading = line.match(/^=+\s*(.+?)\s*=+$/);
    if (heading) {
      out.push("", heading[1]!.toUpperCase(), "");
      continue;
    }
    const spoken = line.replace(/^[:*#]+\s*/, "").match(/^([A-Z][A-Za-z.'’ -]{0,30}?)\s*(\([^)]*\))?\s*:\s*(.+)$/);
    if (spoken && !/^(INT|EXT|NOTE|SOURCE)\b/i.test(spoken[1]!)) {
      out.push("", `${spoken[1]!.trim().toUpperCase()}${spoken[2] ? ` ${spoken[2]}` : ""}`, spoken[3]!.trim());
      continue;
    }
    out.push(line.replace(/^[:*#]+\s*/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function main(): Promise<void> {
  console.log(`Fetching ${PAGE} from Wikisource…`);
  let text = await wikitext(PAGE);
  // A transcript split into subpages ([[/Part]] links): fetch each one.
  const subpages = [...text.matchAll(/\[\[\/([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => `${PAGE}/${m[1]!.trim()}`);
  if (subpages.length) {
    const parts: string[] = [];
    for (const page of subpages) {
      console.log(`  …${page}`);
      parts.push(`== ${page.split("/").at(-1)} ==\n${await wikitext(page)}`);
    }
    text = parts.join("\n\n");
  }
  const script = asScript(text);
  const header = [
    "# Night of the Living Dead (1968)",
    "",
    "A transcript of the film, from Wikisource (https://en.wikisource.org/wiki/Night_of_the_Living_Dead), where it's marked public domain. The film is in the public domain in the US: it was released in 1968 without a copyright notice. Speakers are written as cue lines (the name in capitals, the words under it), so the library can find who says what.",
    "",
  ].join("\n");
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${header}\n${script}\n`);
  const cues = script.split("\n").filter((l) => /^[A-Z][A-Z.'’ -]+( \(.*\))?$/.test(l.trim())).length;
  console.log(`Saved ${OUT} (${script.length.toLocaleString()} characters, ${cues} lines of dialogue).`);
  console.log("Commit it, and Kinaera ships it as the orientation's library example.");
}

if (import.meta.main) await main();
