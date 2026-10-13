/**
 * The small header at the top of seed and tag files: a few `key: value`
 * lines between two `---` lines, then the Markdown body.
 *
 *   ---
 *   id: social.twitter-2010s
 *   label: Twitter (2010s)
 *   order: 1
 *   avoid_terms: [Twitter, tweet, retweet,
 *                 hashtag]
 *   ---
 *
 * It's the plain part of YAML these files use, read by hand so there's
 * nothing to install: text, whole numbers, true and false, and lists in
 * square brackets (which may run over several lines). Quotes around a value
 * are taken off. Anything fancier isn't needed, and isn't read.
 */

export type HeaderValue = string | number | boolean | string[];
export type Header = Record<string, HeaderValue>;

/** Split a file into its header and body. A file with no header has an empty one. */
export function splitFrontmatter(text: string): { header: Header; body: string; hasHeader: boolean } {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const match = normalized.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) return { header: {}, body: normalized.trim(), hasHeader: false };
  return { header: parseHeader(match[1]!), body: normalized.slice(match[0].length).trim(), hasHeader: true };
}

/** Read the lines between the `---` lines. */
export function parseHeader(text: string): Header {
  const header: Header = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    // A list can run over several lines, until its closing bracket.
    if (value.startsWith("[")) {
      while (!value.includes("]") && i + 1 < lines.length) value += ` ${lines[++i]!.trim()}`;
      header[key] = parseList(value);
    } else {
      header[key] = parseScalar(value);
    }
  }
  return header;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

function parseScalar(value: string): string | number | boolean {
  const v = unquote(value);
  if (v !== value.trim()) return v; // quoted: always text
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function parseList(value: string): string[] {
  const inner = value.slice(value.indexOf("[") + 1, value.lastIndexOf("]") === -1 ? undefined : value.lastIndexOf("]"));
  return inner
    .split(",")
    .map((item) => unquote(item))
    .filter((item) => item !== "");
}

/** One value as text, whatever it was written as ("" when missing). */
export function headerText(header: Header, key: string): string {
  const value = header[key];
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** One value as a list (a single value becomes a list of one; missing is empty). */
export function headerList(header: Header, key: string): string[] {
  const value = header[key];
  if (value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** A value as it's written back: lists in brackets, wrapped to stay readable. */
function formatValue(key: string, value: HeaderValue): string {
  if (!Array.isArray(value)) {
    const text = String(value);
    // Quote text that would read back as something else.
    return /^(true|false|-?\d+)$/.test(text) && typeof value === "string" ? `"${text}"` : /[[\]]|^\s|\s$|^["']/.test(text) ? JSON.stringify(text) : text;
  }
  if (value.length === 0) return "[]";
  const indent = " ".repeat(key.length + 3);
  const lines: string[] = [];
  let current = "";
  for (const [i, item] of value.entries()) {
    const piece = `${item}${i < value.length - 1 ? "," : ""}`;
    if (current && (current.length + piece.length + 1 + indent.length) > 72) {
      lines.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  lines.push(current);
  return `[${lines.join(`\n${indent}`)}]`;
}

/** Write a header and body back into one file, keys in the order given. */
export function writeFrontmatter(header: Header, body: string): string {
  const lines = Object.entries(header).map(([key, value]) => `${key}: ${formatValue(key, value)}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}
