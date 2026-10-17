/**
 * Tests for the second rename (docs/orientation-1.md): data saved while
 * your kinwriter was still a "friend" inside opens as "kinwriter".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, openDatabase, runStep } from "../src/db.ts";
import { folderEntries } from "../src/datafolders.ts";
import { createHub } from "../src/hub.ts";
import { createApp } from "../src/server.ts";
import { Store, validateSettings } from "../src/store.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  dir.cleanup();
});

/** A database as Kinaera left it before the rename: layout 16, with "friend" all over it. */
function oldDatabase(path: string): void {
  const old = new Database(path, { strict: true });
  old.exec("PRAGMA foreign_keys = ON");
  for (const step of MIGRATIONS.slice(0, 16)) runStep(old, step);
  old.exec("PRAGMA user_version = 16");
  old.exec(`
    INSERT INTO settings (key, value) VALUES ('friendName', '"Mira"'), ('friendPronouns', '"she/her"'), ('friendColor', '200');
    INSERT INTO channels (id, name, kind, position, created_at) VALUES ('c', 'story', 'rp', 0, 'then');
    INSERT INTO messages (id, channel_id, author, content, created_at, edited_by) VALUES ('m1', 'c', 'user', 'Hello.', 'then', 'friend');
    INSERT INTO messages (id, channel_id, author, content, created_at, deleted_by, deleted_at) VALUES ('m2', 'c', 'friend', 'Hi!', 'then', 'friend', 'later');
    INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('m3', 'c', 'friend', 'The last one.', 'then');
    DELETE FROM messages WHERE id = 'm3';
    INSERT INTO message_revisions (message_id, content, author, created_at) VALUES ('m1', 'Hullo.', 'friend', 'then');
    INSERT INTO reactions (message_id, author, emoji, created_at) VALUES ('m1', 'friend', '🌊', 'then'), ('m1', 'user', '🌊', 'then');
    INSERT INTO comments (id, message_id, thread_id, author, note, created_at) VALUES ('t', 'm1', 't', 'friend', 'Nice.', 'then');
    INSERT INTO notebook_folders (id, name, owner, position, created_at) VALUES ('f', 'Theirs', 'friend', 0, 'then');
    INSERT INTO notebook_entries (id, kind, name, folder_id, owner, created_at, updated_at) VALUES ('e', 'character', 'Wren', 'f', 'friend', 'then', 'then');
    INSERT INTO notebook_suggestions (id, entry_id, author, change, created_at) VALUES ('s', 'e', 'friend', '{}', 'then');
    INSERT INTO identity_versions (identity, author, status, created_at) VALUES ('I am Mira.', 'friend', 'accepted', 'then');
    INSERT INTO relationships (friend_id, name, note, updated_at) VALUES ('wren', 'Wren', 'Kind.', 'then');
    INSERT INTO app_state (key, value) VALUES
      ('scratchpad:c:shared', '{"text":"notes","by":"friend","at":"then","rev":2,"previous":{"text":"n","by":"friend","at":"then"}}');
  `);
  old.close();
}

describe("a database from before", () => {
  test("says kinwriter wherever it said friend", () => {
    const path = join(dir.path, "kinaera.db");
    oldDatabase(path);
    const db = openDatabase(path);
    const one = (sql: string) => db.query(sql).all();
    expect(one("SELECT id, author, edited_by, deleted_by FROM messages ORDER BY seq")).toEqual([
      { id: "m1", author: "user", edited_by: "kinwriter", deleted_by: null },
      { id: "m2", author: "kinwriter", edited_by: null, deleted_by: "kinwriter" },
    ]);
    expect(one("SELECT author FROM message_revisions")).toEqual([{ author: "kinwriter" }]);
    expect(one("SELECT author FROM reactions ORDER BY author")).toEqual([{ author: "kinwriter" }, { author: "user" }]);
    expect(one("SELECT author FROM comments")).toEqual([{ author: "kinwriter" }]);
    expect(one("SELECT owner FROM notebook_folders")).toEqual([{ owner: "kinwriter" }]);
    expect(one("SELECT owner, folder_id FROM notebook_entries")).toEqual([{ owner: "kinwriter", folder_id: "f" }]);
    expect(one("SELECT author FROM notebook_suggestions")).toEqual([{ author: "kinwriter" }]);
    expect(one("SELECT author FROM identity_versions")).toEqual([{ author: "kinwriter" }]);
    expect(one("SELECT kinwriter_id FROM relationships")).toEqual([{ kinwriter_id: "wren" }]);
    expect(one("SELECT key FROM settings WHERE key LIKE 'friend%'")).toEqual([]);
    const pad = JSON.parse((db.query("SELECT value FROM app_state WHERE key = 'scratchpad:c:shared'").get() as { value: string }).value);
    expect([pad.by, pad.previous.by, pad.text]).toEqual(["kinwriter", "kinwriter", "notes"]);
    // The old word is refused from now on, and the indexes are back.
    expect(() => db.exec("INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('x', 'c', 'friend', '.', 'now')")).toThrow();
    const indexes = (one("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL") as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("messages_by_channel");
    expect(indexes).toContain("comments_by_message");
    // Messages keep counting from where they were, past the deleted one.
    db.exec("INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('m4', 'c', 'kinwriter', '.', 'now')");
    expect(db.query("SELECT seq FROM messages WHERE id = 'm4'").get()).toEqual({ seq: 4 });
    db.close();
  });

  test("keeps its settings, under their new names", () => {
    oldDatabase(join(dir.path, "kinaera.db"));
    const store = new Store(dir.path);
    const settings = store.getSettings();
    expect([settings.kinwriterName, settings.kinwriterPronouns, settings.kinwriterColor]).toEqual(["Mira", "she/her", 200]);
    store.close();
  });
});

describe("a data folder from before", () => {
  let fake: FakeNanoGpt;
  beforeEach(() => {
    fake = startFakeNanoGpt();
  });
  afterEach(() => {
    fake.stop();
  });

  /** A hub.json with `friends` lists, and a second kinwriter in friends/wren/. */
  function oldFolder(): void {
    createApp(testConfig(dir.path, fake.baseUrl)).store.close();
    const wren = join(dir.path, "friends", "wren");
    mkdirSync(wren, { recursive: true });
    const app = createApp({ ...testConfig(wren, fake.baseUrl), kinwriterId: "wren" });
    app.store.updateSettings(validateSettings({ kinwriterName: "Wren" }));
    app.store.close();
    writeFileSync(
      join(dir.path, "hub.json"),
      JSON.stringify({
        friends: [
          { id: "home", dir: "." },
          { id: "wren", dir: "friends/wren" },
        ],
        servers: [{ id: "s", name: "", friends: ["home", "wren"] }],
        groups: [{ id: "g", kind: "dm", name: "", serverId: "s", friends: ["home", "wren"], visible: false, createdAt: "then" }],
      }),
    );
  }

  test("moves its kinwriters out of friends/, and renames hub.json's lists", async () => {
    oldFolder();
    // Before it's opened, it can still be read (as an old folder is).
    expect(folderEntries(dir.path).map((f) => f.dir)).toEqual([".", "friends/wren"]);
    const hub = createHub(testConfig(dir.path, fake.baseUrl));
    try {
      const response = await hub.fetch(new Request("http://localhost/api/hub"));
      const data = (await response.json()) as any;
      expect(data.servers[0].kinwriters.map((k: any) => [k.id, k.name])).toEqual([
        ["home", "Arlo"],
        ["wren", "Wren"],
      ]);
      const saved = JSON.parse(readFileSync(join(dir.path, "hub.json"), "utf8"));
      expect(saved.friends).toBeUndefined();
      expect(saved.kinwriters.map((k: any) => k.dir)).toEqual([".", join("kinwriters", "wren")]);
      expect(saved.servers[0].kinwriters).toEqual(["home", "wren"]);
      expect(saved.groups[0].kinwriters).toEqual(["home", "wren"]);
      expect(existsSync(join(dir.path, "kinwriters", "wren", "kinaera.db"))).toBe(true);
      expect(existsSync(join(dir.path, "friends"))).toBe(false);
    } finally {
      hub.close();
    }
  });

  test("a start that stopped after moving the folder finishes the job", async () => {
    oldFolder();
    mkdirSync(join(dir.path, "kinwriters"));
    const { renameSync } = await import("node:fs");
    renameSync(join(dir.path, "friends", "wren"), join(dir.path, "kinwriters", "wren"));
    const hub = createHub(testConfig(dir.path, fake.baseUrl));
    try {
      expect(hub.apps.get("wren")!.store.getSettings().kinwriterName).toBe("Wren");
      expect(JSON.parse(readFileSync(join(dir.path, "hub.json"), "utf8")).kinwriters[1].dir).toBe(join("kinwriters", "wren"));
    } finally {
      hub.close();
    }
  });
});
