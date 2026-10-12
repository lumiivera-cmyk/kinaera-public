/**
 * The practice world (src/practiceworld.ts): written for each kinwriter from
 * who they are, instead of the same fixed lighthouse keeper every time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { atSea, readWorld, rollCharacterSeed, rollWorldSeeds } from "../src/practiceworld.ts";
import { createApp, type App } from "../src/server.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

const WORLD = {
  place: { name: "The Glass Orchard", summary: "A greenhouse city on a mountainside.", details: "Nobody picks fruit after dark." },
  local: { name: "Bram Osei", pronouns: "he/him", age: 40, personality: "Gruff." },
  event: { name: "The Frost Vigil", summary: "The night the heaters fail." },
  character: { name: "Sefa Lind", age: "29", role: "Glazier", speech: "Clipped." },
  partner: { name: "Wren Halloway", about: "A botanist who lost her seeds." },
  channel: "#Night Shift!",
  posts: ["*Wren knocks.*", "*She sets down a tin.*"],
};

describe("reading a world", () => {
  test("every note, the example character and the scene, with fields labelled", () => {
    const world = readWorld(WORLD);
    expect(world.notes.map((n) => [n.kind, n.name])).toEqual([
      ["lore", "The Glass Orchard"],
      ["character", "Bram Osei"],
      ["lore", "The Frost Vigil"],
    ]);
    expect(world.notes[1]!.fields).toEqual([
      { label: "Pronouns", value: "he/him" },
      { label: "Age", value: "40" },
      { label: "Personality", value: "Gruff." },
    ]);
    expect(world.character).toMatchObject({ kind: "character", name: "Sefa Lind" });
    expect(world.scene).toEqual({ channel: "night-shift", partnerName: "Wren Halloway", partnerAbout: "A botanist who lost her seeds.", posts: WORLD.posts });
    expect(world.generated).toBe(true);
  });

  test("throws without the notes, a partner, or two posts", () => {
    expect(() => readWorld({ ...WORLD, posts: ["only one"] })).toThrow();
    expect(() => readWorld({ ...WORLD, partner: {} })).toThrow();
    expect(() => readWorld({ ...WORLD, place: null, local: null, event: null })).toThrow();
    expect(() => readWorld(null)).toThrow();
  });

  test("its ingredients are rolled, so worlds differ", () => {
    const seen = new Set(Array.from({ length: 40 }, () => JSON.stringify(rollWorldSeeds())));
    expect(seen.size).toBeGreaterThan(30);
  });
});

describe("a brand-new server's example character", () => {
  let fake: FakeNanoGpt;
  let dir: ReturnType<typeof tempDir>;
  let app: App;
  beforeEach(() => {
    fake = startFakeNanoGpt();
    dir = tempDir();
    app = createApp(testConfig(dir.path, fake.baseUrl, { example: "generate" }));
  });
  afterEach(() => {
    app.summarizer.stop();
    app.store.close();
    fake.stop();
    dir.cleanup();
  });

  const story = () => app.store.listChannels().find((c) => c.name === "story")!;
  async function settle() {
    for (let i = 0; i < 200 && fake.requests.length === 0; i++) await Bun.sleep(5);
    await Bun.sleep(20);
  }

  test("isn't fixed: #story waits for one, written from who they are by the summary profile", async () => {
    expect(app.store.notebook.castFor("user", story().id)).toEqual([]);
    fake.replies.push({ content: JSON.stringify(WORLD) });
    app.started();
    await settle();
    const sent = JSON.stringify(fake.requests[0]!.messages);
    expect(sent).toContain(app.store.getSettings().friendName);
    expect(sent).toContain("Keep it exactly this");
    expect(sent).not.toMatch(/lighthouse|harbou?r|dock/i);
    expect(app.store.notebook.castFor("user", story().id).map((c) => [c.name, c.owner])).toEqual([["Sefa Lind", "friend"]]);
    // Its notes became the practice notes too.
    expect(app.store.notebook.listEntries("friend", true).map((e) => e.name)).toEqual(expect.arrayContaining(["The Glass Orchard", "Bram Osei"]));
    // Only once.
    app.started();
    await Bun.sleep(20);
    expect(fake.requests).toHaveLength(1);
  });

  test("if the reply can't be read, the built-in practice notes stay and it tries again next time", async () => {
    fake.replies.push({ content: "Sorry, I can't do JSON today." });
    app.started();
    await settle();
    expect(app.store.notebook.castFor("user", story().id)).toEqual([]);
    expect(app.store.notebook.listEntries("friend", true).map((e) => e.name)).toContain("Odile Varga");
    fake.replies.push({ content: JSON.stringify(WORLD) });
    app.started();
    await Bun.sleep(50);
    expect(app.store.notebook.castFor("user", story().id).map((c) => c.name)).toEqual(["Sefa Lind"]);
  });
});

describe("staying off the water", () => {
  test("a world at sea is caught by its words, and an inland one isn't", () => {
    const inland = readWorld(WORLD);
    expect(atSea(inland)).toBe(false);
    expect(atSea({ ...inland, scene: { ...inland.scene, partnerAbout: "A dockworker with a grudge." } })).toBe(true);
    expect(atSea({ ...inland, notes: [{ kind: "lore", name: "The Old Pier", fields: [] }] })).toBe(true);
  });

  test("their character's starting point is rolled: a job and a want", () => {
    expect(rollCharacterSeed(() => 0)).toBe("a night-shift pharmacist who wants to be forgiven by someone who's dead");
    expect(new Set(Array.from({ length: 30 }, () => rollCharacterSeed())).size).toBeGreaterThan(20);
  });
});
