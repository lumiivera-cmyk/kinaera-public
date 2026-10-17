/**
 * Background pictures: your own images behind the app, in place of the
 * theme's own backdrop. Made for the glass themes, where the glass bends and
 * frosts whatever is behind it, but they work under any theme.
 *
 * Pictures are files in one folder shared by every kinwriter (like your own
 * themes): `<dataDir>/backgrounds/<id>.<ext>`, served at
 * `/backgrounds/<file>`. Which one shows (if any) is a setting,
 * `appBackground`, chosen per kinwriter like the app theme.
 *
 * JPEG, PNG, WebP and GIF (animated GIFs move). Each file's first bytes are
 * checked, so a file is what its name says.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "./errors.ts";

/** A picture, as Appearance lists them. */
export interface BackgroundInfo {
  /** The file name, e.g. "3f2a9c1e.gif". This is what `appBackground` holds. */
  file: string;
  /** Where the page loads it from. */
  url: string;
  bytes: number;
  /** When it was added (ms since 1970), for showing newest first. */
  added: number;
}

/** Big enough for a long animated GIF; still fine to send from a phone. */
export const MAX_BACKGROUND_BYTES = 25 * 1024 * 1024;
const MAX_BACKGROUNDS = 60;

/** Our own file names: 8 to 36 letters, digits and dashes, and a known extension. */
export const BACKGROUND_FILE = /^[a-z0-9][a-z0-9-]{7,35}\.(?:jpg|png|webp|gif)$/;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const HEADERS = {
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "script-src 'none'",
};

/** What kind of image some bytes are, from their first few bytes, or null. */
export function imageKind(bytes: Uint8Array): ".jpg" | ".png" | ".webp" | ".gif" | null {
  const starts = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  const text = (from: number, s: string) => [...s].every((c, i) => bytes[from + i] === c.charCodeAt(0));
  if (starts(0xff, 0xd8, 0xff)) return ".jpg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return ".png";
  if (text(0, "GIF87a") || text(0, "GIF89a")) return ".gif";
  if (text(0, "RIFF") && text(8, "WEBP")) return ".webp";
  return null;
}

/** The pictures in the backgrounds folder. */
export class BackgroundLibrary {
  constructor(private readonly folder: string) {
    mkdirSync(folder, { recursive: true });
  }

  /** Every picture, newest first. */
  list(): BackgroundInfo[] {
    if (!existsSync(this.folder)) return [];
    return readdirSync(this.folder)
      .filter((name) => BACKGROUND_FILE.test(name))
      .map((file) => {
        const stats = statSync(join(this.folder, file));
        return { file, url: `/backgrounds/${file}`, bytes: stats.size, added: stats.mtimeMs };
      })
      .sort((a, b) => b.added - a.added);
  }

  exists(file: string): boolean {
    return BACKGROUND_FILE.test(file) && existsSync(join(this.folder, file));
  }

  /**
   * Add a picture. Its type comes from its contents, not the name it was
   * uploaded with; anything that isn't a JPEG, PNG, WebP or GIF is refused.
   */
  add(bytes: Uint8Array): BackgroundInfo {
    const kind = imageKind(bytes);
    if (!kind) throw new ValidationError("Background pictures must be .jpg, .png, .webp or .gif images.");
    if (bytes.length > MAX_BACKGROUND_BYTES) {
      throw new ValidationError(`Background pictures can be ${MAX_BACKGROUND_BYTES / 1024 / 1024} MB at most.`);
    }
    if (this.list().length >= MAX_BACKGROUNDS) {
      throw new ValidationError(`You can keep ${MAX_BACKGROUNDS} background pictures at most. Remove one first.`);
    }
    const file = `${randomUUID().slice(0, 8)}${kind}`;
    writeFileSync(join(this.folder, file), bytes);
    return this.list().find((b) => b.file === file)!;
  }

  remove(file: string): void {
    if (!this.exists(file)) throw new NotFoundError("background picture");
    rmSync(join(this.folder, file));
  }

  /** Serve `/backgrounds/<file>`, or null if there's no such picture. */
  serve(file: string): Response | null {
    if (!this.exists(file)) return null;
    const type = CONTENT_TYPES[extname(file)]!;
    return new Response(Bun.file(join(this.folder, file)), { headers: { ...HEADERS, "Content-Type": type } });
  }
}
