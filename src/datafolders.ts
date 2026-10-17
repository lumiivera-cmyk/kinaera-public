/**
 * Your data folders, old and current (developer panel only, for now).
 *
 * `bun run fresh` (and **Start fresh** in the developer panel) sets the
 * whole data folder aside as `data-old-<date>` and starts over. This file
 * is everything around that:
 *
 *   - **The old folders**: each `<data>-old-*` folder next to your data
 *     folder, with the kinwriters in it (from its `hub.json`, or the one
 *     kinwriter of a folder from before there were several).
 *   - **Browsing** a kinwriter in one, read-only: their channels and
 *     messages. It reads a copy of their database, upgraded to the current
 *     layout, so an old folder is never changed. Their journal, drafts and
 *     DMs aren't shown here: those are theirs.
 *   - **Exporting** a kinwriter, old or current, as one file: a JSON bundle
 *     with their database (a clean snapshot) and their custom emoji images.
 *   - **Importing** one, from an old folder or an exported file, as a new
 *     kinwriter: their database is upgraded to the current layout as it opens.
 *   - **Starting fresh**: the work `bun run fresh` does, shared with the app.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { defaultSettings, SETUP_PENDING, Store } from "./store.ts";
import { ownKeys, syncProfiles } from "./universal.ts";
import type { Message, Settings } from "./types.ts";

/** What an exported kinwriter file says it is. */
export const BUNDLE_FORMAT = "kinaera-kinwriter";
export const BUNDLE_VERSION = 1;

export interface KinwriterBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  name: string;
  /** Their database (kinaera.db), base64. */
  database: string;
  /** Their custom emoji images, by file name, base64. */
  emojis: Record<string, string>;
}

/** A kinwriter as a data folder lists them. */
export interface FolderKinwriter {
  id: string;
  name: string;
  avatar: string;
  archived: boolean;
  channels: number;
  messages: number;
  lastMessageAt: string | null;
  /** Set when their database couldn't be read. */
  error?: string;
}

export interface DataFolder {
  /** "current", or the old folder's name ("data-old-2026-10-01-13-11"). */
  id: string;
  path: string;
  modifiedAt: string;
  kinwriters: FolderKinwriter[];
}

// ------------------------------------------------------------- folders

/** The old folders next to your data folder, newest first. */
export function oldFolderNames(dataDir: string): string[] {
  const parent = dirname(resolve(dataDir));
  const prefix = `${basename(resolve(dataDir))}-old-`;
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && /^[\w.-]+$/.test(name) && existsSync(join(parent, name, "kinaera.db")))
    .sort()
    .reverse();
}

/** A folder by its id: "current", or one of the old folders' names (never any other path). */
export function folderPath(dataDir: string, id: string): string {
  if (id === "current") return resolve(dataDir);
  if (!oldFolderNames(dataDir).includes(id)) throw new Error("There's no old folder by that name.");
  return join(dirname(resolve(dataDir)), id);
}

/**
 * A hub.json as this version names things. Before the second rename
 * (docs/orientation-1.md) its lists were called `friends`: the hub's list of
 * kinwriters, and each server's and group's. An old folder keeps those
 * names, so they're read either way. Folders aren't moved here (the hub
 * does that for the current one).
 */
export function renamedRegistry<T>(parsed: unknown): T {
  const rename = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    const record = o as Record<string, unknown>;
    if ("friends" in record) {
      if (!("kinwriters" in record)) record.kinwriters = record.friends;
      delete record.friends;
    }
  };
  rename(parsed);
  const record = (parsed ?? {}) as { servers?: unknown; groups?: unknown };
  for (const list of [record.servers, record.groups]) if (Array.isArray(list)) list.forEach(rename);
  return parsed as T;
}

/** The kinwriters in a folder: from its hub.json, or the one kinwriter of an older folder. */
export function folderEntries(path: string): { id: string; dir: string; archived: boolean }[] {
  const registry = join(path, "hub.json");
  if (!existsSync(registry)) return [{ id: "home", dir: ".", archived: false }];
  const parsed = renamedRegistry<{ kinwriters?: { id: string; dir: string; archived?: unknown }[] }>(JSON.parse(readFileSync(registry, "utf8")));
  return (parsed.kinwriters ?? [])
    .filter((f) => typeof f.id === "string" && typeof f.dir === "string" && insideFolder(path, f.dir))
    .map((f) => ({ id: f.id, dir: f.dir, archived: Boolean(f.archived) }));
}

/** A kinwriter's own folder within a data folder (never outside it). */
export function kinwriterDir(path: string, id: string): string {
  const entry = folderEntries(path).find((f) => f.id === id);
  if (!entry) throw new Error("There's no such kinwriter in that folder.");
  return resolve(path, entry.dir);
}

function insideFolder(root: string, dir: string): boolean {
  const target = resolve(root, dir);
  const rel = relative(resolve(root), target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`));
}

/** One kinwriter's name in a folder (their id if it can't be read), without reading the others. */
export function kinwriterNameIn(dataDir: string, folder: string, id: string): string {
  const path = folderPath(dataDir, folder);
  const entry = folderEntries(path).find((f) => f.id === id);
  if (!entry) return id;
  const found = describeKinwriter(resolve(path, entry.dir), entry.id, entry.archived, folder === "current");
  return found.error ? id : found.name;
}

/** A folder and its kinwriters, read without changing anything. */
export function describeFolder(dataDir: string, id: string): DataFolder {
  const path = folderPath(dataDir, id);
  return {
    id,
    path,
    modifiedAt: statSync(path).mtime.toISOString(),
    kinwriters: folderEntries(path).map((entry) => describeKinwriter(resolve(path, entry.dir), entry.id, entry.archived, id === "current")),
  };
}

/**
 * A database's files copied somewhere else, to open without touching the
 * original's folder: even a read-only open leaves SQLite's side files
 * (`-shm`, `-wal`) behind. An old folder isn't in use, so a file copy is
 * consistent.
 */
function copyOf(path: string): { file: string; done: () => void } {
  const work = mkdtempSync(join(tmpdir(), "kinaera-copy-"));
  const file = join(work, "kinaera.db");
  copyFileSync(path, file);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${file}-wal`);
  return { file, done: () => rmSync(work, { recursive: true, force: true }) };
}

/**
 * A kinwriter's name and how much they have, from whatever layout their
 * database is in. An old folder's is read from a copy; the current one's
 * (open in the app already) directly.
 */
function describeKinwriter(dir: string, id: string, archived: boolean, live: boolean): FolderKinwriter {
  const base = { id, name: id, avatar: "", archived, channels: 0, messages: 0, lastMessageAt: null };
  const path = join(dir, "kinaera.db");
  if (!existsSync(path)) return { ...base, error: "No database here." };
  let db: Database | null = null;
  const copy = live ? null : copyOf(path);
  try {
    db = copy ? new Database(copy.file) : new Database(path, { readonly: true });
    const setting = (key: string) => {
      const row = db!.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
      if (!row) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return row.value;
      }
    };
    const count = (sql: string) => (db!.query(sql).get() as { n: number }).n;
    const last = db.query("SELECT MAX(created_at) AS at FROM messages").get() as { at: string | null };
    // An old folder's database may be from before the second rename.
    const [name, avatar] = [setting("kinwriterName") ?? setting("friendName"), setting("kinwriterAvatar") ?? setting("friendAvatar")];
    return {
      ...base,
      name: typeof name === "string" ? name : "Your kinwriter",
      avatar: typeof avatar === "string" ? avatar : "",
      channels: count("SELECT COUNT(*) AS n FROM channels"),
      messages: count("SELECT COUNT(*) AS n FROM messages"),
      lastMessageAt: last.at,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
    copy?.done();
  }
}

// ------------------------------------------------------------ browsing

/** Read-only copies opened for browsing, upgraded to the current layout; the newest few are kept open. */
const browsing = new Map<string, { store: Store; dir: string }>();
const BROWSE_KEEP = 2;

/**
 * A clean snapshot of a database, written to a new file: from the open
 * database itself (the current kinwriter, consistent while it's in use),
 * or from a copy of an old folder's files (so that folder is untouched).
 */
function snapshot(source: string | Database, target: string): void {
  if (typeof source !== "string") {
    source.query("VACUUM INTO ?").run(target);
    return;
  }
  const copy = copyOf(source);
  const db = new Database(copy.file);
  try {
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
    copy.done();
  }
}

/**
 * An old kinwriter, opened from a copy so their folder is never changed.
 * A current one (`live`: their open database) changes as you look, so
 * their copy is made new every time.
 */
function browseStore(dataDir: string, folder: string, id: string, live?: Database): Store {
  const key = `${folder}/${id}`;
  const open = browsing.get(key);
  if (open && folder === "current") {
    open.store.close();
    rmSync(open.dir, { recursive: true, force: true });
    browsing.delete(key);
  } else if (open) {
    // Most recently used last.
    browsing.delete(key);
    browsing.set(key, open);
    return open.store;
  }
  const dir = mkdtempSync(join(tmpdir(), "kinaera-browse-"));
  snapshot(live ?? join(kinwriterDir(folderPath(dataDir, folder), id), "kinaera.db"), join(dir, "kinaera.db"));
  const store = new Store(dir, { example: false });
  browsing.set(key, { store, dir });
  while (browsing.size > BROWSE_KEEP) {
    const [oldest, entry] = browsing.entries().next().value!;
    entry.store.close();
    rmSync(entry.dir, { recursive: true, force: true });
    browsing.delete(oldest);
  }
  return store;
}

/** Close every browsing copy (before the folders change, and when the app stops). */
export function closeBrowsing(): void {
  for (const entry of browsing.values()) {
    entry.store.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
  browsing.clear();
}

/** An old kinwriter's channels (not DMs: those are between kinwriters). */
export function browseKinwriter(dataDir: string, folder: string, id: string, live?: Database) {
  const store = browseStore(dataDir, folder, id, live);
  const settings = store.getSettings();
  return {
    name: settings.kinwriterName,
    avatar: settings.kinwriterAvatar,
    identity: store.identity.current()?.identity ?? settings.kinwriterPrompt,
    channels: store
      .listChannels()
      .filter((c) => c.kind !== "dm")
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind, messages: store.getMessages(c.id).filter((m) => m.kind === "post").length })),
  };
}

/** A channel's messages, read-only: the newest `limit`, or those before a message. */
export function browseMessages(dataDir: string, folder: string, id: string, channelId: string, before?: string, limit = 100, live?: Database) {
  const store = browseStore(dataDir, folder, id, live);
  const channel = store.getChannel(channelId);
  if (channel.kind === "dm") throw new Error("DMs between kinwriters aren't shown here.");
  let messages: Message[] = store.getMessages(channelId);
  if (before) {
    const at = messages.findIndex((m) => m.id === before);
    if (at >= 0) messages = messages.slice(0, at);
  }
  const page = messages.slice(-limit);
  return {
    channel: { id: channel.id, name: channel.name, kind: channel.kind },
    more: messages.length > page.length,
    messages: page.map((m) => ({ id: m.id, kind: m.kind, author: m.author, speaker: m.speaker?.name ?? null, content: m.content, createdAt: m.createdAt })),
  };
}

// ------------------------------------------------------- export, import

/**
 * A kinwriter as one file, from their folder `dir`. `open` is their open
 * database, for the current one (an old one's is read from its folder);
 * their emoji images come from their folder either way.
 */
export function exportKinwriter(dir: string, name: string, open?: Database): KinwriterBundle {
  const work = mkdtempSync(join(tmpdir(), "kinaera-export-"));
  try {
    const file = join(work, "kinaera.db");
    snapshot(open ?? join(dir, "kinaera.db"), file);
    const emojis: Record<string, string> = {};
    const emojiDir = join(dir, "emojis");
    if (existsSync(emojiDir)) {
      for (const entry of readdirSync(emojiDir)) {
        const path = join(emojiDir, entry);
        if (statSync(path).isFile()) emojis[entry] = readFileSync(path).toString("base64");
      }
    }
    return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), name, database: readFileSync(file).toString("base64"), emojis };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Check an exported file before anything is written. */
export function readBundle(input: unknown): KinwriterBundle {
  const bundle = input as Partial<KinwriterBundle>;
  if (!bundle || bundle.format !== BUNDLE_FORMAT) throw new Error("That isn't an exported kinwriter.");
  if (typeof bundle.version !== "number" || bundle.version > BUNDLE_VERSION) throw new Error("That file is from a newer Kinaera. Update first.");
  if (typeof bundle.database !== "string") throw new Error("The file has no database in it.");
  const bytes = Buffer.from(bundle.database, "base64");
  if (bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") throw new Error("The database in that file is damaged.");
  for (const name of Object.keys(bundle.emojis ?? {})) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("The file has an emoji with a bad name.");
  }
  return { ...bundle, emojis: bundle.emojis ?? {} } as KinwriterBundle;
}

/**
 * Write a kinwriter into a new folder: their database and emoji images.
 * Opening it (in the hub) upgrades it to the current layout. Refuses a
 * database that isn't a kinwriter's.
 */
export function writeKinwriter(target: string, bundle: KinwriterBundle): void {
  if (existsSync(target)) throw new Error("That folder is already in use.");
  const work = mkdtempSync(join(tmpdir(), "kinaera-import-"));
  try {
    const file = join(work, "kinaera.db");
    writeFileSync(file, Buffer.from(bundle.database, "base64"));
    const db = new Database(file, { readonly: true });
    try {
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
      for (const needed of ["settings", "channels", "messages"]) {
        if (!tables.has(needed)) throw new Error("That database isn't a kinwriter's.");
      }
    } finally {
      db.close();
    }
    mkdirSync(target, { recursive: true });
    renameSync(file, join(target, "kinaera.db"));
    const emojiNames = Object.keys(bundle.emojis);
    if (emojiNames.length) {
      mkdirSync(join(target, "emojis"), { recursive: true });
      for (const name of emojiNames) writeFileSync(join(target, "emojis", name), Buffer.from(bundle.emojis[name]!, "base64"));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --------------------------------------------------------- fresh start

/** The settings every kinwriter shares, from a folder's hub.json (none in an older folder). */
function sharedSettings(dataDir: string): Partial<Settings> {
  try {
    const registry = JSON.parse(readFileSync(join(dataDir, "hub.json"), "utf8")) as { settings?: Partial<Settings> };
    return registry.settings ?? {};
  } catch {
    return {};
  }
}

/**
 * The kinwriter a fresh start takes your profiles and preferences from: the
 * first one in the sidebar who isn't archived (an archived one missed the
 * newest changes), as a folder relative to the data folder. The first
 * kinwriter may have been deleted, so it's not always the data folder itself.
 * Null when there's no kinwriter's database at all.
 */
export function freshSource(dataDir: string): string | null {
  let order: string[] = [];
  try {
    const registry = renamedRegistry<{ servers?: { kinwriters?: string[] }[] }>(JSON.parse(readFileSync(join(dataDir, "hub.json"), "utf8")));
    order = (registry.servers ?? []).flatMap((s) => s.kinwriters ?? []);
  } catch {
    // An older folder, with no hub.json: just the one kinwriter.
  }
  const entries = folderEntries(dataDir).filter((f) => !f.archived);
  const sorted = [...entries].sort((a, b) => rank(order, a.id) - rank(order, b.id));
  return sorted.find((f) => existsSync(join(dataDir, f.dir, "kinaera.db")))?.dir ?? null;
}

/** Where an id is in the sidebar's order (not there: last). */
const rank = (order: string[], id: string) => (order.includes(id) ? order.indexOf(id) : order.length);

/**
 * Set the whole data folder aside and start over (everything must be
 * closed first). What's yours carries over, from the first kinwriter in
 * the sidebar (`freshSource`): your connection profiles and roulettes, your
 * preferences (not what makes the kinwriter themselves), your themes, background pictures and
 * your prompt edits. Returns where the old folder went.
 */
export function startFresh(dataDir: string, keep: { kinwriterKeys: (keyof Settings)[] }): { aside: string; profiles: number } {
  const source = freshSource(dataDir);
  if (source === null) throw new Error("There's no kinwriter here to start fresh from.");
  const old = new Store(resolve(dataDir, source), { example: false });
  // A section that was just theirs starts from the defaults, unless it's shared (below).
  const own = ownKeys(old);
  const defaults = defaultSettings();
  const preferences = {
    ...Object.fromEntries(
      Object.entries(old.getSettings())
        .filter(([key]) => !keep.kinwriterKeys.includes(key as keyof Settings))
        .map(([key, value]) => [key, own.has(key as keyof Settings) ? defaults[key as keyof Settings] : value]),
    ),
    // The shared settings (src/universal.ts), not that kinwriter's own sections.
    ...sharedSettings(dataDir),
  } as Partial<Settings>;
  old.close();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  let aside = `${resolve(dataDir)}-old-${stamp}`;
  for (let i = 2; existsSync(aside); i++) aside = `${resolve(dataDir)}-old-${stamp}-${i}`;
  renameSync(dataDir, aside);

  // No example character: you make your new kinwriter yourself, in the app.
  const store = new Store(dataDir, { example: false });
  // Opened normally, not read-only: closing it then leaves no side files in the old folder.
  const previous = new Database(join(aside, source, "kinaera.db"));
  const profiles = (previous.query("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }).n;
  syncProfiles(previous, store.db);
  previous.close();
  store.updateSettings(preferences);
  // The app opens on "Meet your new kinwriter"; their orientation is offered once they're made.
  store.appState.set("orientation.pending", null);
  store.appState.set(SETUP_PENDING, "1");
  store.close();
  if (existsSync(join(aside, "themes"))) cpSync(join(aside, "themes"), join(dataDir, "themes"), { recursive: true });
  if (existsSync(join(aside, "backgrounds"))) cpSync(join(aside, "backgrounds"), join(dataDir, "backgrounds"), { recursive: true });
  if (existsSync(join(aside, "prompts.json"))) cpSync(join(aside, "prompts.json"), join(dataDir, "prompts.json"));
  return { aside, profiles };
}

/**
 * Whether Kinaera is running at `host`:`port`, for `bun run fresh` (which
 * mustn't move the folder out from under it): "stopped" only when nothing
 * is listening there (the connection is refused). Anything else (it took
 * too long, or another error) is "unknown": better to refuse than guess.
 */
export async function serverState(host: string, port: number, timeoutMs = 1500): Promise<"running" | "stopped" | "unknown"> {
  // Listening on every address: it answers on this machine's own.
  const hostname = host === "" || host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "::1" : host.replace(/^\[(.*)\]$/, "$1");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connecting = Bun.connect({ hostname, port, socket: { data() {} } });
    const timeout = new Promise<null>((done) => (timer = setTimeout(() => done(null), timeoutMs)));
    const socket = await Promise.race([connecting, timeout]);
    if (!socket) {
      void connecting.then((s) => s.end(), () => {});
      return "unknown";
    }
    socket.end();
    return "running";
  } catch (error) {
    return (error as { code?: string }).code === "ECONNREFUSED" ? "stopped" : "unknown";
  } finally {
    clearTimeout(timer);
  }
}
