/**
 * Tests for shared settings (src/universal.ts): one Settings menu, and one
 * set of profiles and roulettes, for every kinwriter, with sections a
 * kinwriter can have just for themselves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import { ownGroups } from "../src/universal.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  hub = createHub(testConfig(dir.path, fake.baseUrl));
});

afterEach(() => {
  hub.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await hub.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
}

const app = (id: string) => hub.apps.get(id)!;
const settingsOf = (id: string) => app(id).store.getSettings();

/** A second kinwriter, on a server of their own. */
async function wren(): Promise<string> {
  return (await call("POST", "/api/hub/servers", { name: "Wren", prompt: "You are Wren." })).data.kinwriterId;
}

describe("settings", () => {
  test("saved while looking at one kinwriter, they're everyone's", async () => {
    const id = await wren();
    expect((await call("PUT", `/p/${id}/api/settings`, { heartbeatHours: 6, historyLimit: 40, hardLimits: "No gore." })).status).toBe(200);
    expect(settingsOf("home")).toMatchObject({ heartbeatHours: 6, historyLimit: 40, hardLimits: "No gore." });
    // Kept by the hub, for kinwriters made later.
    const third = (await call("POST", "/api/hub/servers", { name: "Sol", prompt: "You are Sol." })).data.kinwriterId;
    expect(settingsOf(third)).toMatchObject({ heartbeatHours: 6, historyLimit: 40 });
  });

  test("who a kinwriter is stays theirs", async () => {
    const id = await wren();
    await call("PUT", `/p/${id}/api/settings`, { kinwriterName: "Wren the Second", literaryPrompt: "Wren's style" });
    expect(settingsOf("home").kinwriterName).toBe("Arlo");
    expect(settingsOf("home").literaryPrompt).not.toBe("Wren's style");
  });

  test("a section just for one kinwriter: their changes stay theirs, and everyone else's pass them by", async () => {
    const id = await wren();
    const own = await call("PUT", `/api/hub/kinwriters/${id}/own`, { group: "reaching", own: true });
    expect(own.data.own).toEqual(["reaching"]);
    expect((await call("GET", `/p/${id}/api/state`)).data.ownSettings).toEqual(["reaching"]);

    await call("PUT", `/p/${id}/api/settings`, { heartbeatHours: 2, historyLimit: 50 });
    expect(settingsOf("home").heartbeatHours).toBe(0);
    // Memory isn't Wren's own: shared.
    expect(settingsOf("home").historyLimit).toBe(50);

    await call("PUT", "/p/home/api/settings", { heartbeatHours: 12 });
    expect(settingsOf(id).heartbeatHours).toBe(2);

    // Shared again: back to everyone's.
    const back = await call("PUT", `/api/hub/kinwriters/${id}/own`, { group: "reaching", own: false });
    expect(back.data).toMatchObject({ own: [], settings: { heartbeatHours: 12 } });
    expect(settingsOf(id).heartbeatHours).toBe(12);
  });

  test("bad input", async () => {
    expect((await call("PUT", "/api/hub/kinwriters/home/own", { group: "jev", own: true })).status).toBe(400);
    expect((await call("PUT", "/api/hub/kinwriters/home/own", { group: "reaching", own: "yes" })).status).toBe(400);
    expect((await call("PUT", "/api/hub/kinwriters/nobody/own", { group: "reaching", own: true })).status).toBe(404);
  });
});

describe("the look", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

  test("a theme, its sliders and a picture chosen while looking at one kinwriter are everyone's, unless it's just theirs", async () => {
    const id = await wren();
    await call("PUT", `/p/${id}/api/settings`, { appTheme: "liquid-glass-dark", themeOptions: { "rainy-window": { rain: 0.3 } } });
    expect(settingsOf("home")).toMatchObject({ appTheme: "liquid-glass-dark", themeOptions: { "rainy-window": { rain: 0.3 } } });
    // A new picture shows straight away, for everyone.
    const file = (await call("POST", `/p/${id}/api/backgrounds`, { data: png })).data.background.file;
    expect(settingsOf("home").appBackground).toBe(file);
    const third = (await call("POST", "/api/hub/servers", { name: "Sol", prompt: "You are Sol." })).data.kinwriterId;
    expect(settingsOf(third)).toMatchObject({ appTheme: "liquid-glass-dark", appBackground: file });

    expect((await call("PUT", `/api/hub/kinwriters/${id}/own`, { group: "look", own: true })).data.own).toEqual(["look"]);
    await call("PUT", `/p/${id}/api/settings`, { appTheme: "classic", appBackground: "" });
    expect(settingsOf("home")).toMatchObject({ appTheme: "liquid-glass-dark", appBackground: file });
    // Shared again: back to everyone's.
    const back = await call("PUT", `/api/hub/kinwriters/${id}/own`, { group: "look", own: false });
    expect(back.data.settings).toMatchObject({ appTheme: "liquid-glass-dark", appBackground: file });
  });

  test("a theme or picture deleted is gone for everyone, even a kinwriter whose look is their own", async () => {
    const id = await wren();
    const theme = (await call("POST", "/p/home/api/themes", { name: "Short-lived" })).data.theme.id;
    const file = (await call("POST", "/p/home/api/backgrounds", { data: png })).data.background.file;
    await call("PUT", "/p/home/api/settings", { appTheme: theme, themeOptions: { [theme]: { glow: 1 } } });
    await call("PUT", `/api/hub/kinwriters/${id}/own`, { group: "look", own: true });
    const third = (await call("POST", "/api/hub/servers", { name: "Sol", prompt: "You are Sol." })).data.kinwriterId;

    expect((await call("DELETE", `/p/${third}/api/themes/${theme}`, {})).status).toBe(200);
    expect((await call("DELETE", `/p/${third}/api/backgrounds/${file}`, {})).status).toBe(200);
    for (const who of ["home", id, third]) {
      expect(settingsOf(who)).toMatchObject({ appTheme: "classic", themeOptions: {}, appBackground: "" });
    }
    const shared = JSON.parse(readFileSync(join(dir.path, "hub.json"), "utf8")).settings;
    expect(shared).toMatchObject({ appTheme: "classic", themeOptions: {}, appBackground: "" });
  });
});

describe("profiles and roulettes", () => {
  test("made, changed and deleted while looking at one kinwriter: the same for everyone", async () => {
    const id = await wren();
    const made = await call("POST", `/p/${id}/api/profiles`, { name: "GLM", model: "glm-4.6" });
    const glm = made.data.profile.id;
    expect(app("home").store.profiles.get(glm).model).toBe("glm-4.6");

    // A kinwriter's note on a profile survives the profile changing.
    app("home").store.continuity.writeProfileNote(glm, "Loves em dashes.");
    await call("PATCH", `/p/${id}/api/profiles/${glm}`, { temperature: 1.2 });
    expect(app("home").store.profiles.get(glm).temperature).toBe(1.2);
    expect(app("home").store.continuity.profileNotes().get(glm)?.note).toBe("Loves em dashes.");

    const roulette = (await call("POST", "/p/home/api/roulettes", { name: "Mix", entries: [{ profileId: glm, weight: 1 }] })).data.roulette;
    expect(app(id).store.profiles.getRoulette(roulette.id).entries).toEqual([{ profileId: glm, weight: 1 }]);

    // Assigned, then deleted: assignments everywhere go back to the default.
    await call("PUT", "/p/home/api/settings", { rpAssignment: `profile:${glm}` });
    expect(settingsOf(id).rpAssignment).toBe(`profile:${glm}`);
    expect((await call("DELETE", `/p/${id}/api/profiles/${glm}`, {})).status).toBe(200);
    expect(app("home").store.profiles.list().some((p) => p.id === glm)).toBe(false);
    expect(settingsOf("home").rpAssignment).toBe("");
    expect(app("home").store.profiles.getRoulette(roulette.id).entries).toEqual([]);
  });
});

describe("a setting added after settings were shared", () => {
  test("is shared from a kinwriter who doesn't keep that section, not one who does", async () => {
    const id = await wren();
    expect((await call("PUT", `/api/hub/kinwriters/home/own`, { group: "reaching", own: true })).status).toBe(200);
    app("home").store.updateSettings({ heartbeatHours: 6 });
    hub.close();
    // As if heartbeatHours were new: the hub never wrote it down.
    const path = join(dir.path, "hub.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    delete registry.settings.heartbeatHours;
    writeFileSync(path, JSON.stringify(registry));
    hub = createHub(testConfig(dir.path, fake.baseUrl));
    expect(JSON.parse(readFileSync(path, "utf8")).settings.heartbeatHours).toBe(app(id).store.getSettings().heartbeatHours);
    expect(app(id).store.getSettings().heartbeatHours).toBe(0);
  });

  test("anyone who had it different keeps theirs, as their own (the look, once each kinwriter's)", async () => {
    const id = await wren();
    app("home").store.updateSettings({ appTheme: "liquid-glass-dark" });
    app(id).store.updateSettings({ appTheme: "rainy-window", backgroundDim: 0.4 });
    hub.close();
    const path = join(dir.path, "hub.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    for (const key of ["appTheme", "themeOptions", "appBackground", "backgroundDim"]) delete registry.settings[key];
    writeFileSync(path, JSON.stringify(registry));
    hub = createHub(testConfig(dir.path, fake.baseUrl));

    // Arlo's (the first server's) is the shared look; Wren keeps theirs.
    expect(JSON.parse(readFileSync(path, "utf8")).settings.appTheme).toBe("liquid-glass-dark");
    expect(ownGroups(app("home").store)).toEqual([]);
    expect(ownGroups(app(id).store)).toEqual(["look"]);
    expect(settingsOf(id)).toMatchObject({ appTheme: "rainy-window", backgroundDim: 0.4 });
    await call("PUT", "/p/home/api/settings", { appTheme: "classic" });
    expect(settingsOf(id).appTheme).toBe("rainy-window");
  });
});

describe("a hub from before settings were shared", () => {
  test("becomes one set, losing nothing: differences become that kinwriter's own", async () => {
    const id = await wren();
    const [first] = app("home").store.profiles.list();
    hub.close();

    // Back when each kinwriter had their own: Wren's differ.
    const path = join(dir.path, "hub.json");
    const registry = JSON.parse(readFileSync(path, "utf8"));
    delete registry.settings;
    writeFileSync(path, JSON.stringify(registry));
    hub = createHub(testConfig(dir.path, fake.baseUrl));
    const w = app(id).store;
    w.profiles.update(first!.id, { temperature: 0.3 });
    w.continuity.writeProfileNote(first!.id, "Calm.");
    const own = w.profiles.create({ name: "Wren's model", model: "wren-1" });
    w.updateSettings({ rpAssignment: `profile:${first!.id}`, heartbeatHours: 4, hardLimits: "No spiders." });
    app("home").store.updateSettings({ hardLimits: "No gore." });
    hub.close();
    writeFileSync(path, JSON.stringify(registry));
    hub = createHub(testConfig(dir.path, fake.baseUrl));

    const home = app("home").store;
    const wrenStore = app(id).store;
    // Arlo's (the first server's) settings are the shared ones; Wren keeps theirs as their own.
    expect(home.getSettings().heartbeatHours).toBe(0);
    expect(wrenStore.getSettings().heartbeatHours).toBe(4);
    expect(ownGroups(wrenStore)).toEqual(["models", "reaching"]);
    expect(ownGroups(home)).toEqual([]);
    // Hard limits: both, for everyone.
    expect(home.getSettings().hardLimits).toBe("No gore.\nNo spiders.");
    expect(wrenStore.getSettings().hardLimits).toBe("No gore.\nNo spiders.");

    // One set of profiles, the same for both.
    const ids = (s: typeof home) => s.profiles.list().map((p) => p.id);
    expect(ids(wrenStore)).toEqual(ids(home));
    expect(home.profiles.get(first!.id).temperature).toBe(first!.temperature);
    expect(home.profiles.get(own.id).name).toBe("Wren's model");
    // Wren's changed copy is a profile of its own, still what Wren writes with, with Wren's note.
    const copy = home.profiles.list().find((p) => p.name === `${first!.name} (Wren)`)!;
    expect(copy.temperature).toBe(0.3);
    expect(wrenStore.getSettings().rpAssignment).toBe(`profile:${copy.id}`);
    expect(wrenStore.continuity.profileNotes().get(copy.id)?.note).toBe("Calm.");
  });
});
