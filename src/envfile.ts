/**
 * Settings → API key and setup: your `.env` file, edited in the app instead of in
 * a text editor in Termux.
 *
 * Bun reads `.env` once, when the server starts (src/config.ts), so a change
 * only takes effect after a restart: Ctrl-C in Termux, then `bun start`. The
 * screen says so, and keeps saying so until the running server matches the
 * file.
 *
 * Only these settings can be changed here, each in its own field, so the
 * file keeps its comments, its order and anything else you put in it.
 * Left out on purpose:
 *
 *   - NANOGPT_BASE_URL: if the page could change where requests go, anyone
 *     who could open the app could send your API key to their own server.
 *   - DATA_DIR: changing it would look like every kinwriter vanished.
 *
 * Both can still be changed by editing the file itself.
 *
 * Your API key is never sent to the page: it only learns whether one is set,
 * and its last four characters, so you can tell which key it is. You can
 * replace it, not read it.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "./config.ts";

/** The settings the screen edits, besides the API key. */
export const ENV_FIELDS = ["HOST", "PORT", "ALLOWED_HOSTS", "REQUEST_TIMEOUT_SECONDS", "DEVELOPER_PANEL"] as const;
export type EnvField = (typeof ENV_FIELDS)[number];
const API_KEY = "NANOGPT_API_KEY";

/** What the screen shows: never the API key itself. */
export interface EnvView {
  /** Whether `.env` exists yet (if not, saving makes it from `.env.example`). */
  exists: boolean;
  /** Each field's value in the file; "" means not set (the default is used). */
  values: Record<EnvField, string>;
  apiKey: { set: boolean; ending: string };
  /** The file says something different from what the server is running with. */
  restartNeeded: boolean;
}

export interface EnvChange {
  values?: Partial<Record<EnvField, string>>;
  /** A new API key; "" (or leaving it out) keeps the one in the file. */
  apiKey?: string;
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENTED = /^\s*#\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** The variables a `.env` text sets (the last one wins, as in Bun). */
export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(LINE);
    if (match) vars[match[1]!] = unquote(match[2]!);
  }
  return vars;
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = value.match(/^(['"`])(.*)\1/);
  if (quoted) return quoted[1] === '"' ? quoted[2]!.replace(/\\n/g, "\n") : quoted[2]!;
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * `value` as it's written after `KEY=`. Plain when it's only ordinary
 * characters; otherwise in single quotes, so Bun takes it exactly as it is
 * (no `$VARIABLE` expansion, no `#` comment).
 */
function quote(value: string): string {
  if (/^[A-Za-z0-9_\-.:,/@+]*$/.test(value)) return value;
  return `'${value}'`;
}

/**
 * `text` with each changed variable set: in place where it's already set,
 * by un-commenting its line from `.env.example` (`# PORT=4747`), or else
 * added at the end. `null` (or "") comments out the line, so the default
 * is used and the line is still there to fill in later.
 */
export function updateEnv(text: string, changes: Record<string, string | null>): string {
  const lines = text === "" ? [] : text.split(/\r?\n/);
  // A file ending in a newline splits to a last "": keep it last.
  const trailing = lines.length > 0 && lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  for (const [key, value] of Object.entries(changes)) {
    const set = lines.map((line, i) => (line.match(LINE)?.[1] === key ? i : -1)).filter((i) => i >= 0);
    const written = value ? `${key}=${quote(value)}` : `# ${key}=`;
    if (set.length > 0) {
      lines[set[0]!] = written;
      // Later copies would win over it: take them out.
      for (const i of set.slice(1).reverse()) lines.splice(i, 1);
      continue;
    }
    if (!value) continue; // not set already
    const commented = lines.findIndex((line) => line.match(COMMENTED)?.[1] === key);
    if (commented >= 0) lines[commented] = written;
    else lines.push(written);
  }
  return lines.join("\n") + "\n";
}

/** Why `value` can't be saved for `key`, or null if it can. */
export function envProblem(key: EnvField | typeof API_KEY, value: string): string | null {
  if (/[\r\n']/.test(value)) return `${key} can't have line breaks or ' in it.`;
  if (value === "") return null;
  switch (key) {
    case "PORT":
      return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : "The port is a whole number from 1 to 65535.";
    case "REQUEST_TIMEOUT_SECONDS":
      return /^\d+$/.test(value) && Number(value) >= 1 ? null : "How long to wait is a whole number of seconds, 1 or more.";
    case "DEVELOPER_PANEL":
      return value === "1" ? null : "The developer panel is 1 (on) or empty (off).";
    case "HOST":
      return /^[A-Za-z0-9.:\-\[\]]+$/.test(value) ? null : "Where it listens is an address like 127.0.0.1 or 0.0.0.0.";
    case "ALLOWED_HOSTS":
      return /^[A-Za-z0-9.\-:, ]+$/.test(value) ? null : "Other names are machine names separated by commas, like my-phone.tail1234.ts.net.";
    case API_KEY:
      return /\s/.test(value) ? "The API key can't have spaces in it." : null;
  }
}

/** The `.env` file and the server running from it. */
export class EnvFile {
  constructor(
    readonly path: string,
    /** What the server is running with now (read from `.env` when it started). */
    private readonly running: Config,
  ) {}

  private read(): string {
    if (existsSync(this.path)) return readFileSync(this.path, "utf8");
    const example = join(dirname(this.path), ".env.example");
    return existsSync(example) ? readFileSync(example, "utf8") : "";
  }

  view(): EnvView {
    const exists = existsSync(this.path);
    const vars = exists ? parseEnv(readFileSync(this.path, "utf8")) : {};
    const key = (vars[API_KEY] ?? "").trim();
    return {
      exists,
      values: Object.fromEntries(ENV_FIELDS.map((f) => [f, vars[f] ?? ""])) as Record<EnvField, string>,
      apiKey: { set: key !== "", ending: key.length > 8 ? key.slice(-4) : "" },
      restartNeeded: exists && this.differs(vars),
    };
  }

  /**
   * Whether the server would start differently from this file. (Something
   * set in Termux itself, like `PORT=5000 bun start`, wins over `.env` and
   * isn't seen here: then this can say "restart" when it isn't needed.)
   */
  private differs(vars: Record<string, string>): boolean {
    let next: Config;
    try {
      next = loadConfig(vars);
    } catch {
      return true; // it wouldn't start at all as written
    }
    const r = this.running;
    return (
      next.host !== r.host ||
      next.port !== r.port ||
      next.apiKey !== r.apiKey ||
      next.requestTimeoutMs !== r.requestTimeoutMs ||
      Boolean(next.developerPanel) !== Boolean(r.developerPanel) ||
      (next.allowedHosts ?? []).join(",") !== (r.allowedHosts ?? []).join(",")
    );
  }

  /** Save the changes to the file. Nothing is changed if any value is wrong. */
  save(change: EnvChange): EnvView {
    const changes: Record<string, string | null> = {};
    for (const [field, raw] of Object.entries(change.values ?? {})) {
      if (!(ENV_FIELDS as readonly string[]).includes(field)) throw new Error(`${field} can't be changed here. You can edit .env itself.`);
      if (typeof raw !== "string") throw new Error(`${field} must be text.`);
      const value = raw.trim();
      const problem = envProblem(field as EnvField, value);
      if (problem) throw new Error(problem);
      changes[field] = value || null;
    }
    if (change.apiKey !== undefined) {
      if (typeof change.apiKey !== "string") throw new Error("The API key must be text.");
      const key = change.apiKey.trim();
      const problem = envProblem(API_KEY, key);
      if (problem) throw new Error(problem);
      // "" keeps the key: the field starts empty, since the page never has it.
      if (key) changes[API_KEY] = key;
    }
    const next = updateEnv(this.read(), changes);
    const temp = `${this.path}.saving`;
    writeFileSync(temp, next, { mode: 0o600 });
    renameSync(temp, this.path);
    return this.view();
  }
}
