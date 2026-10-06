/**
 * Tests for connection profiles and roulettes (src/profiles.ts): making and
 * checking profiles, weighted picks, and what happens when something that's
 * in use is deleted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { requestBody } from "../src/nanogpt.ts";
import { profileRequest } from "../src/kinwriter.ts";
import { parseExtraParams, weightedPick } from "../src/profiles.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS, openDatabase } from "../src/db.ts";
import { Store } from "../src/store.ts";
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

describe("profiles", () => {
  test("a new server starts with one profile, writing both jobs", () => {
    const [first] = store.profiles.list();
    expect(first).toMatchObject({ model: "deepseek-ai/DeepSeek-V3.1-Terminus", temperature: 0.8, topP: 0.95, minP: 0.025, supportsTools: true });
    expect(store.getSettings()).toMatchObject({ rpAssignment: `profile:${first!.id}`, oocAssignment: `profile:${first!.id}` });
  });

  test("can be made with just a name and a model, and changed", () => {
    const glm = store.profiles.create({ name: "GLM", model: "zai/glm-5.2" });
    expect(glm).toMatchObject({ temperature: 0.9, maxTokens: 1024, topP: null, reasoningEffort: null, quirkPrompt: "" });
    const changed = store.profiles.update(glm.id, { topP: 0.95, reasoningEffort: "low", supportsTools: false });
    expect(changed).toMatchObject({ name: "GLM", topP: 0.95, reasoningEffort: "low", supportsTools: false });
  });

  test.each([
    [{ name: "", model: "m" }, /name can't be empty/],
    [{ name: "x", model: "m", temperature: 3 }, /temperature must be between/],
    [{ name: "x", model: "m", maxTokens: 1.5 }, /whole number/],
    [{ name: "x", model: "m", reasoningEffort: "max" }, /reasoningEffort/],
    [{ name: "x", model: "m", extraParams: "top_k: 40" }, /must be JSON/],
    [{ name: "x", model: "m", extraParams: "[1]" }, /JSON object/],
    [{ name: "x", model: "m", extraParams: '{"model": "other"}' }, /can't set "model"/],
  ])("rejects %j", (input, error) => {
    expect(() => store.profiles.create(input)).toThrow(error);
  });

  test("the last profile can't be deleted", () => {
    expect(() => store.profiles.delete(store.profiles.list()[0]!.id)).toThrow(/at least one profile/);
  });

  test("deleting one in use puts its jobs and channels back to the default", () => {
    const glm = store.profiles.create({ name: "GLM", model: "zai/glm-5.2" });
    const story = store.listChannels()[0]!;
    store.updateSettings({ oocAssignment: `profile:${glm.id}` });
    store.updateChannel(story.id, { assignment: `profile:${glm.id}` });

    store.profiles.delete(glm.id);
    expect(store.getSettings().oocAssignment).toBe("");
    expect(store.getChannel(story.id).assignment).toBeNull();
  });
});

describe("min P", () => {
  test("a profile setting of its own: null leaves it to the model", () => {
    const plain = store.profiles.create({ name: "x", model: "m" });
    expect(plain.minP).toBeNull();
    expect(requestBody({ ...profileRequest(plain), messages: [] })).not.toHaveProperty("min_p");
    const set = store.profiles.update(plain.id, { minP: 0.05 });
    expect(requestBody({ ...profileRequest(set), messages: [] })).toMatchObject({ min_p: 0.05 });
    expect(() => store.profiles.update(plain.id, { minP: 2 })).toThrow("minP must be between 0 and 1");
    expect(store.profiles.update(plain.id, { minP: null }).minP).toBeNull();
  });

  test("set, it wins over min_p in the extra fields; unset, the extra field still goes", () => {
    const profile = store.profiles.create({ name: "x", model: "m", extraParams: '{"min_p": 0.1}' });
    expect(requestBody({ ...profileRequest(profile), messages: [] })).toMatchObject({ min_p: 0.1 });
    const set = store.profiles.update(profile.id, { minP: 0.025 });
    expect(requestBody({ ...profileRequest(set), messages: [] })).toMatchObject({ min_p: 0.025 });
  });

  test("an older database keeps its profiles exactly as they were", () => {
    const path = join(dir.path, "older.db");
    const old = new Database(path, { strict: true });
    old.exec("PRAGMA foreign_keys = ON");
    for (const step of MIGRATIONS.slice(0, 8)) typeof step === "string" ? old.exec(step) : typeof step === "function" ? step(old) : old.exec(step.rebuild);
    old.exec("PRAGMA user_version = 8");
    old.query("INSERT INTO profiles (id, name, model, temperature, max_tokens, position, created_at) VALUES ('p', 'Old', 'deepseek-ai/DeepSeek-V3.1-Terminus', 0.9, 1024, 0, 'then')").run();
    old.close();
    const db = openDatabase(path);
    expect(db.query("SELECT id, temperature, top_p, min_p FROM profiles").all()).toEqual([{ id: "p", temperature: 0.9, top_p: null, min_p: null }]);
    db.close();
  });
});

describe("the request a profile makes", () => {
  test("sends only the settings that are set", () => {
    // A profile with only the defaults (the starting one sets top P and min P).
    const first = store.profiles.create({ name: "plain", model: "m" });
    const body = requestBody({ ...profileRequest(first!), messages: [] });
    expect(body).toEqual({
      model: first!.model,
      messages: [],
      temperature: 0.9,
      max_tokens: 1024,
      stream: false,
    });
  });

  test("adds top-p, reasoning and extra fields, which can't override the app's own", () => {
    const profile = store.profiles.create({
      name: "x",
      model: "m",
      topP: 0.9,
      reasoningEffort: "high",
      extraParams: '{"top_k": 40, "temperature": 2}',
    });
    const body = requestBody({ ...profileRequest(profile), messages: [] });
    expect(body).toMatchObject({ top_p: 0.9, reasoning_effort: "high", top_k: 40, temperature: 0.9 });
  });

  test("an empty extra-fields box means none", () => {
    expect(parseExtraParams("  ")).toEqual({});
  });
});

describe("roulettes", () => {
  test("pick by weight", () => {
    const entries = [
      { name: "a", weight: 1 },
      { name: "b", weight: 3 },
    ];
    // The line is a (0 to 1) then b (1 to 4): 0.2 of 4 is 0.8, in a.
    expect(weightedPick(entries, 0.2)!.name).toBe("a");
    expect(weightedPick(entries, 0.3)!.name).toBe("b");
    expect(weightedPick(entries, 0.99)!.name).toBe("b");
    expect(weightedPick([], 0.5)).toBeUndefined();
  });

  test("pick one of their profiles each turn", () => {
    const [deepseek] = store.profiles.list();
    const glm = store.profiles.create({ name: "GLM", model: "zai/glm-5.2" });
    const mix = store.profiles.createRoulette({
      name: "Mix",
      entries: [
        { profileId: deepseek!.id, weight: 1 },
        { profileId: glm.id, weight: 1 },
      ],
    });
    expect(store.profiles.pick(`roulette:${mix.id}`, false, 0.1).name).toBe(deepseek!.name);
    expect(store.profiles.pick(`roulette:${mix.id}`, false, 0.9).name).toBe("GLM");
  });

  test("agentic jobs draw only from tool-capable profiles, if there are any", () => {
    const [deepseek] = store.profiles.list();
    const noTools = store.profiles.create({ name: "No tools", model: "m", supportsTools: false });
    const mix = store.profiles.createRoulette({
      name: "Mix",
      entries: [
        { profileId: noTools.id, weight: 99 },
        { profileId: deepseek!.id, weight: 1 },
      ],
    });
    expect(store.profiles.pick(`roulette:${mix.id}`, true, 0.1).id).toBe(deepseek!.id);
    expect(store.profiles.pick(`roulette:${mix.id}`, false, 0.1).id).toBe(noTools.id);
  });

  test("fall back to the first profile when empty or pointing at nothing", () => {
    const [first] = store.profiles.list();
    const empty = store.profiles.createRoulette({ name: "Empty" });
    expect(store.profiles.pick(`roulette:${empty.id}`, false).id).toBe(first!.id);
    expect(store.profiles.pick("profile:gone", false).id).toBe(first!.id);
    expect(store.profiles.pick("", false).id).toBe(first!.id);
  });

  test("reject bad entries", () => {
    const [first] = store.profiles.list();
    expect(() => store.profiles.createRoulette({ name: "x", entries: [{ profileId: "nope", weight: 1 }] })).toThrow(
      /doesn't exist/,
    );
    expect(() => store.profiles.createRoulette({ name: "x", entries: [{ profileId: first!.id, weight: 0 }] })).toThrow(
      /weight/,
    );
    const twice = [
      { profileId: first!.id, weight: 1 },
      { profileId: first!.id, weight: 2 },
    ];
    expect(() => store.profiles.createRoulette({ name: "x", entries: twice })).toThrow(/only be in a roulette once/);
  });

  test("lose a deleted profile, and deleting one in use resets its jobs", () => {
    const [first] = store.profiles.list();
    const glm = store.profiles.create({ name: "GLM", model: "zai/glm-5.2" });
    const mix = store.profiles.createRoulette({
      name: "Mix",
      entries: [
        { profileId: first!.id, weight: 1 },
        { profileId: glm.id, weight: 1 },
      ],
    });
    store.profiles.delete(glm.id);
    expect(store.profiles.getRoulette(mix.id).entries).toEqual([{ profileId: first!.id, weight: 1 }]);

    store.updateSettings({ rpAssignment: `roulette:${mix.id}` });
    store.profiles.deleteRoulette(mix.id);
    expect(store.getSettings().rpAssignment).toBe("");
  });
});
