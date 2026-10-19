/**
 * Tests for the database and store (src/db.ts, src/store.ts): starting
 * content, channels, messages and the characters they voice, and rejecting
 * bad input.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";
import { NotFoundError, ValidationError } from "../src/errors.ts";
import { Store, validateNewChannel, validateSettings } from "../src/store.ts";
import { tempDir } from "./helpers.ts";

let dir: ReturnType<typeof tempDir>;
let store: Store;

beforeEach(() => {
  dir = tempDir();
  store = new Store(dir.path);
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

describe("a new server", () => {
  test("starts with #story and #ooc", () => {
    const [story, ooc] = store.listChannels();
    expect(story).toMatchObject({ name: "story", kind: "rp", position: 0 });
    expect(ooc).toMatchObject({ name: "ooc", kind: "ooc", position: 1 });
  });

  test("has the example character in the notebook, pinned to #story", () => {
    const [story, ooc] = store.listChannels();
    const [ilse] = store.notebook.listEntries("user");
    expect(ilse).toMatchObject({ name: "Ilse Marrow", kind: "character", owner: "kinwriter" });
    // The sheet was read into fields.
    expect(ilse!.fields.find((f) => f.label === "Background")!.value).toContain("logbook");
    expect(store.notebook.castFor("user", story!.id).map((c) => c.name)).toEqual(["Ilse Marrow"]);
    expect(store.notebook.castFor("user", ooc!.id)).toEqual([]);
  });

  test("starts with the default settings", () => {
    const settings = store.getSettings();
    expect(settings.kinwriterName).toBe("Arlo");
    expect(settings.kinwriterPrompt).toContain("Arlo");
    // One prompt per kind of channel, each with its own default.
    expect(settings.oocPrompt).toContain("one or two sentences");
    expect(settings.literaryPrompt).toContain("prose");
    expect(settings.casualPrompt).not.toBe("");
  });

  test("isn't re-seeded on restart, even if you deleted every channel", () => {
    for (const channel of store.listChannels()) store.deleteChannel(channel.id);
    store.close();
    store = new Store(dir.path);
    expect(store.listChannels()).toEqual([]);
  });
});

describe("the database layout", () => {
  test("records its version", () => {
    const db = new Database(join(dir.path, "kinaera.db"));
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
  });

  test("starts with the starting loadout: six profiles, and every job assigned", () => {
    const db = openDatabase(join(dir.path, "fresh.db"));
    const profiles = db.query("SELECT id, name FROM profiles ORDER BY position").all() as { id: string; name: string }[];
    expect(profiles).toHaveLength(6);
    const id = (name: string) => profiles.find((p) => p.name === name)!.id;
    expect(db.query("SELECT id FROM roulettes").all()).toEqual([]);
    const setting = (key: string) => JSON.parse((db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value);
    expect(setting("rpAssignment")).toBe(`profile:${id("Gemini 4 Argon")}`);
    expect(setting("oocAssignment")).toBe(`profile:${id("TEE - Gemma 4 31b IT")}`);
    for (const key of ["summaryAssignment", "heartbeatAssignment", "decisionFallback"]) {
      expect(setting(key)).toBe(`profile:${id("TEE - Gemma 4 Decision")}`);
    }
    db.close();
  });

  test("deleting a channel takes its messages and tool calls with it", () => {
    const db = openDatabase(join(dir.path, "cascade.db"));
    db.exec(`INSERT INTO channels (id, name, kind, position, created_at) VALUES ('rp', 'story', 'rp', 0, 'then')`);
    db.exec(`INSERT INTO messages (id, channel_id, author, content, created_at) VALUES ('m1', 'rp', 'user', 'Hi', 'then')`);
    db.exec(`INSERT INTO tool_calls (id, channel_id, turn_id, round, name, arguments, result, status, summary, source, profile, created_at)
             VALUES ('c', 'rp', 't', 0, 'pin', '{}', '{}', 'ok', 'pinned', 'native', NULL, 'then')`);
    db.exec("DELETE FROM channels WHERE id = 'rp'");
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
    db.close();
  });

  test("refuses a database from a newer version of Kinaera", () => {
    const path = join(dir.path, "future.db");
    const db = new Database(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer version/);
  });
});

describe("settings", () => {
  test("keep their changes after a restart", () => {
    store.updateSettings({ historyLimit: 12, kinwriterName: "Sol" });
    store.close();
    store = new Store(dir.path);
    expect(store.getSettings()).toMatchObject({ historyLimit: 12, kinwriterName: "Sol" });
  });
});

describe("channels", () => {
  test("new channels go to the bottom of the sidebar", () => {
    const created = store.createChannel({ name: "heist", kind: "rp" });
    expect(created.position).toBe(2);
    expect(store.listChannels().at(-1)!.id).toBe(created.id);
  });

  test("can be renamed", () => {
    const story = store.listChannels()[0]!;
    expect(store.updateChannel(story.id, { name: "lighthouse" })).toMatchObject({ name: "lighthouse" });
  });

  test("can be reordered, but only with every channel listed exactly once", () => {
    const [a, b] = store.listChannels();
    expect(store.reorderChannels([b!.id, a!.id]).map((c) => c.name)).toEqual(["ooc", "story"]);
    expect(() => store.reorderChannels([a!.id])).toThrow(ValidationError);
    expect(() => store.reorderChannels([a!.id, a!.id])).toThrow(ValidationError);
    expect(() => store.reorderChannels([a!.id, "nope"])).toThrow(ValidationError);
  });

  test("deleting a channel deletes its messages and their characters", () => {
    const story = store.listChannels()[0]!;
    const message = store.addMessage({ channelId: story.id, author: "kinwriter", content: "Hi", characters: ["Ilse"] });
    store.deleteChannel(story.id);

    expect(() => store.getMessage(message.id)).toThrow(NotFoundError);
    const leftovers = store.db.query("SELECT COUNT(*) AS n FROM message_characters").get() as { n: number };
    expect(leftovers.n).toBe(0);
    // Its cast is unpinned, but the characters stay in the notebook.
    const pins = store.db.query("SELECT COUNT(*) AS n FROM channel_cast WHERE channel_id = $id").get({ id: story.id }) as { n: number };
    expect(pins.n).toBe(0);
    expect(store.notebook.listEntries("user")).toHaveLength(1);
  });

  test("unknown channel ids are reported as not found", () => {
    expect(() => store.getChannel("nope")).toThrow(NotFoundError);
    expect(() => store.getMessages("nope")).toThrow(NotFoundError);
    expect(() => store.deleteChannel("nope")).toThrow(NotFoundError);
  });
});

describe("channel modes", () => {
  test("new channels are literary unless told otherwise", () => {
    expect(store.listChannels()[0]!.mode).toBe("literary");
    expect(store.createChannel({ name: "chat", kind: "rp", mode: "casual" }).mode).toBe("casual");
  });

  test("a change applies at once while the current scene is empty", () => {
    const story = store.listChannels()[0]!;
    expect(store.updateChannel(story.id, { mode: "casual" })).toMatchObject({ mode: "casual", pendingMode: null });
  });

  test("a change mid-scene waits for the next scene break", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "user", content: "Hi", mode: "literary" });

    expect(store.updateChannel(story.id, { mode: "casual" })).toMatchObject({ mode: "literary", pendingMode: "casual" });

    const { sceneBreak, channel } = store.addSceneBreak(story.id, "user", "  The Storm ");
    expect(sceneBreak).toMatchObject({ kind: "scene_break", content: "The Storm", author: "user", mode: null });
    expect(channel).toMatchObject({ mode: "casual", pendingMode: null });

    // The new scene is empty, so another change applies at once.
    expect(store.updateChannel(story.id, { mode: "literary" })).toMatchObject({ mode: "literary", pendingMode: null });
  });

  test("asking for the current mode cancels a waiting change", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "user", content: "Hi" });
    store.updateChannel(story.id, { mode: "casual" });
    expect(store.updateChannel(story.id, { mode: "literary" }).pendingMode).toBeNull();
  });

  test("scene breaks are only for roleplay channels", () => {
    const ooc = store.listChannels()[1]!;
    expect(() => store.addSceneBreak(ooc.id, "user", "")).toThrow(ValidationError);
  });
});

describe("turns", () => {
  test("messages added together share a turn id", () => {
    const story = store.listChannels()[0]!;
    const turn = store.addTurn([
      { channelId: story.id, author: "kinwriter", content: "one" },
      { channelId: story.id, author: "kinwriter", content: "two" },
    ]);
    expect(turn[0]!.turnId).toBeString();
    expect(turn[1]!.turnId).toBe(turn[0]!.turnId);
  });

  test("lastKinwriterTurn returns the whole last reply, or nothing", () => {
    const story = store.listChannels()[0]!;
    expect(store.lastKinwriterTurn(story.id)).toEqual([]);

    store.addTurn([{ channelId: story.id, author: "kinwriter", content: "earlier" }]);
    store.addTurn([{ channelId: story.id, author: "user", content: "hi" }]);
    store.addTurn([
      { channelId: story.id, author: "kinwriter", content: "a" },
      { channelId: story.id, author: "kinwriter", content: "b" },
    ]);
    expect(store.lastKinwriterTurn(story.id).map((m) => m.content)).toEqual(["a", "b"]);

    store.addSceneBreak(story.id, "user", "");
    expect(store.lastKinwriterTurn(story.id)).toEqual([]);
  });

  test("an old message without a turn id is a turn of its own", () => {
    const story = store.listChannels()[0]!;
    store.addMessage({ channelId: story.id, author: "kinwriter", content: "old" });
    expect(store.lastKinwriterTurn(story.id).map((m) => m.content)).toEqual(["old"]);
  });
});

describe("messages", () => {
  test("stay in their own channel, in order, with the characters they voice", () => {
    const [story, ooc] = store.listChannels();
    store.addMessage({ channelId: story!.id, author: "user", content: "one" });
    store.addMessage({ channelId: ooc!.id, author: "user", content: "elsewhere" });
    store.addMessage({ channelId: story!.id, author: "kinwriter", content: "two", characters: ["Ilse", "Gull"], model: "m" });

    const messages = store.getMessages(story!.id);
    expect(messages.map((m) => [m.content, m.characters, m.model])).toEqual([
      ["one", [], undefined],
      ["two", ["Ilse", "Gull"], "m"],
    ]);
    expect(store.lastMessage(story!.id)!.content).toBe("two");
    expect(store.getMessages(ooc!.id)).toHaveLength(1);
  });

  test("can be edited, deleted and cleared", () => {
    const story = store.listChannels()[0]!;
    const a = store.addMessage({ channelId: story.id, author: "user", content: "typo" });
    const b = store.addMessage({ channelId: story.id, author: "kinwriter", content: "reply" });

    expect(store.editMessage(a.id, "fixed")).toMatchObject({ content: "fixed", editedAt: expect.any(String) });
    store.deleteMessage(b.id);
    expect(() => store.deleteMessage(b.id)).toThrow(NotFoundError);
    expect(() => store.editMessage("nope", "x")).toThrow(NotFoundError);
    expect(store.getMessages(story.id)).toHaveLength(1);

    store.clearMessages(story.id);
    expect(store.getMessages(story.id)).toHaveLength(0);
  });

  test("the database refuses a message in a channel that doesn't exist", () => {
    expect(() => store.addMessage({ channelId: "nope", author: "user", content: "Hi" })).toThrow(/FOREIGN KEY/);
  });
});

describe("validation", () => {
  test("accepts valid settings and drops unknown fields", () => {
    expect(validateSettings({ historyLimit: 5, rpAssignment: "profile:abc", sneaky: true })).toEqual({
      historyLimit: 5,
      rpAssignment: "profile:abc",
    });
  });

  test.each([
    [{ historyLimit: 0 }, /historyLimit must be between/],
    [{ kinwriterName: "  " }, /kinwriterName must be non-empty/],
    [{ kinwriterPrompt: 42 }, /kinwriterPrompt must be text/],
    [{ rpAssignment: "gpt" }, /rpAssignment must be/],
    [{ themeOptions: { "rainy-window": { "bubble-blur": "lots" } } }, /must be numbers/],
    [{ themeOptions: { "Not A Theme": {} } }, /themeOptions must be a theme id/],
    [{ oocPrompt: 42 }, /oocPrompt must be text/],
    [[], /must be a JSON object/],
  ])("rejects settings %j", (input, error) => {
    expect(() => validateSettings(input)).toThrow(error);
  });

  test.each([
    [{ name: "x", kind: "dm" }, /kind must be/],
    [{ name: "", kind: "rp" }, /name must be non-empty/],
    [{ name: "x".repeat(101), kind: "rp" }, /name is too long/],
    [{ name: "x", kind: "rp", mode: "noir" }, /mode must be/],
  ])("rejects new channel %j", (input, error) => {
    expect(() => validateNewChannel(input)).toThrow(error);
  });
});

describe("fixes", () => {
  const story = () => store.listChannels().find((c) => c.name === "story")!;
  const say = (content: string) => store.addTurn([{ channelId: story().id, author: "user", content }])[0]!;

  test("deleting a channel's first message keeps the branches forked at it", () => {
    const a = say("A");
    say("B");
    store.branchFrom(a.id);
    say("B2");
    store.deleteMessage(a.id);
    const [branch] = store.branches(story().id);
    expect(branch).toMatchObject({ forkId: "start", count: 1, first: { content: "B" } });
    // Going to it sets aside what's in the chat now, from the start.
    const shelved = store.switchBranch(branch!.id);
    expect(store.getMessages(story().id).map((m) => m.content)).toEqual(["B"]);
    expect(shelved).toMatchObject({ forkId: "start", count: 1 });
    expect(store.branches(story().id).map((b) => b.first.content)).toEqual(["B2"]);
  });

  test("a peer's edit or deletion marks the digest that covered it stale", () => {
    const a = say("A");
    store.summaries.save(story().id, "digest", "", "so far", 1_000_000);
    store.mirrorEdit(a.id, "A, edited elsewhere");
    expect(store.summaries.get(story().id, "digest")!.stale).toBe(true);
    store.summaries.save(story().id, "digest", "", "so far", 1_000_000);
    store.mirrorDelete(a.id);
    expect(store.summaries.get(story().id, "digest")!.stale).toBe(true);
  });

  test("a turn that rolls back tells nobody about its messages", () => {
    const events: string[] = [];
    store.onMessageEvent = (event, message) => events.push(`${event}:${message.content}`);
    const before = store.revision;
    // The second message's channel doesn't exist, so the whole turn fails.
    expect(() =>
      store.addTurn([
        { channelId: story().id, author: "user", content: "one" },
        { channelId: "no-such-channel", author: "user", content: "two" },
      ]),
    ).toThrow();
    expect(events).toEqual([]);
    expect(store.revision).toBe(before);
    store.addTurn([{ channelId: story().id, author: "user", content: "three" }]);
    expect(events).toEqual(["added:three"]);
  });

  test("an existing but empty database still gets #story and #ooc", () => {
    store.close();
    const empty = tempDir();
    openDatabase(join(empty.path, "kinaera.db")).close();
    store = new Store(empty.path);
    expect(store.listChannels().map((c) => c.name)).toEqual(["story", "ooc"]);
    store.close();
    // Opening it again doesn't add them twice.
    store = new Store(empty.path);
    expect(store.listChannels().map((c) => c.name)).toEqual(["story", "ooc"]);
    empty.cleanup();
  });

  test("a deleted alternate isn't counted", () => {
    const [old] = store.addTurn([{ channelId: story().id, author: "kinwriter", content: "v1" }]);
    const turnId = crypto.randomUUID();
    store.supersede([old!.id], turnId);
    const [now] = store.addTurn([{ channelId: story().id, author: "kinwriter", content: "v2" }], turnId);
    expect(store.getMessage(now!.id).alternates).toBe(1);
    store.db.query("UPDATE messages SET deleted_at = 'x' WHERE id = $id").run({ id: old!.id });
    expect(store.getMessage(now!.id).alternates).toBe(0);
  });
});
