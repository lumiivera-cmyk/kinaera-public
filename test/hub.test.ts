/**
 * Tests for the hub (src/hub.ts): kinwriters with their own memory, grouped
 * into servers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedHost, createHub, type Hub } from "../src/hub.ts";
import { createApp } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
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

const home = () => hub.apps.get("home")!;

describe("starting", () => {
  test("one server with the first kinwriter, living in the data folder", async () => {
    const { data } = await call("GET", "/api/hub");
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].kinwriters.map((p: any) => [p.id, p.name])).toEqual([["home", "Arlo"]]);
    expect(data.servers[0].kinwriters[0].channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect(existsSync(join(dir.path, "kinaera.db"))).toBe(true);
    expect(existsSync(join(dir.path, "hub.json"))).toBe(true);
  });

  test("an existing Kinaera becomes the first kinwriter, unchanged", async () => {
    hub.close();
    const other = tempDir();
    const old = createApp(testConfig(other.path, fake.baseUrl));
    old.store.updateSettings(validateSettings({ kinwriterName: "Mira" }));
    old.store.close();
    hub = createHub(testConfig(other.path, fake.baseUrl));
    expect((await call("GET", "/api/state")).data.settings.kinwriterName).toBe("Mira");
    hub.close();
    other.cleanup();
    hub = createHub(testConfig(dir.path, fake.baseUrl));
  });

  test("unprefixed and /p/<id>/ requests reach the kinwriter", async () => {
    expect((await call("GET", "/api/state")).data.settings.kinwriterName).toBe("Arlo");
    expect((await call("GET", "/p/home/api/state")).data.settings.kinwriterName).toBe("Arlo");
    expect((await call("GET", "/p/nobody/api/state")).status).toBe(404);
  });
});

describe("a new kinwriter", () => {
  test("gets their own server, their own memory, and your profiles and preferences", async () => {
    home().store.updateSettings(validateSettings({ literaryPrompt: "Arlo's style" }));
    // Settings are shared (src/universal.ts): changed in the app, they're everyone's.
    expect((await call("PUT", "/api/settings", { decisionConfidence: 0.9 })).status).toBe(200);
    const { data } = await call("POST", "/api/hub/servers", { name: "Wren", prompt: "You are Wren.", avatar: "🐦" });
    const wren = data.kinwriterId as string;
    expect(data.servers).toHaveLength(2);
    expect(existsSync(join(dir.path, "kinwriters", wren, "kinaera.db"))).toBe(true);

    const state = (await call("GET", `/p/${wren}/api/state`)).data;
    expect(state.settings).toMatchObject({ kinwriterName: "Wren", kinwriterAvatar: "🐦", decisionConfidence: 0.9 });
    // Who they are is their self-notes: private, so the app doesn't get it (src/selfnotes.ts).
    expect(state.settings.kinwriterPrompt).toBe("");
    expect(hub.apps.get(wren)!.store.identity.current()!.identity).toBe("You are Wren.");
    // Not Arlo's prompts…
    expect(state.settings.literaryPrompt).not.toBe("Arlo's style");
    // …the same connection profiles (same ids, so assignments carry over)…
    expect(state.profiles.map((p: any) => p.id)).toEqual(home().store.profiles.list().map((p) => p.id));
    // …and a clean slate: channels, no example character.
    expect(state.channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect((await call("GET", `/p/${wren}/api/notebook`)).data.entries).toEqual([]);
  });

  test("never sees another kinwriter's notebook or messages", async () => {
    const wren = (await call("POST", "/api/hub/servers", { name: "Wren" })).data.kinwriterId;
    home().store.notebook.createEntry("kinwriter", { kind: "lore", name: "Arlo's secret", visibility: "hidden" });
    const ooc = home().store.listChannels().find((c) => c.kind === "ooc")!;
    home().store.addMessage({ channelId: ooc.id, author: "user", content: "only for Arlo" });
    const wrenApp = hub.apps.get(wren)!;
    expect(wrenApp.store.notebook.listEntries("kinwriter").map((e) => e.name)).toEqual([]);
    expect(wrenApp.store.listChannels().flatMap((c) => wrenApp.store.getMessages(c.id))).toEqual([]);
    // Each kinwriter's turns go to their own prompt.
    const wrenOoc = wrenApp.store.listChannels().find((c) => c.kind === "ooc")!;
    wrenApp.store.addMessage({ channelId: wrenOoc.id, author: "user", content: "hi Wren" });
    await wrenApp.kinwriter.takeTurn(wrenOoc.id, "user-message");
    const prompt = JSON.stringify(fake.requests.at(-1)!.messages);
    expect(prompt).toContain("hi Wren");
    expect(prompt).not.toContain("only for Arlo");
    expect(prompt).not.toContain("Arlo's secret");
  });

  test("several kinwriters in one server", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    const { data } = await call("POST", `/api/hub/servers/${serverId}/kinwriters`, { name: "Wren" });
    expect(data.servers[0].kinwriters.map((p: any) => p.name)).toEqual(["Arlo", "Wren"]);
    // Reorder them, then give Wren a server of her own.
    const reordered = await call("PATCH", `/api/hub/servers/${serverId}`, { kinwriters: [data.kinwriterId, "home"] });
    expect(reordered.data.servers[0].kinwriters.map((p: any) => p.name)).toEqual(["Wren", "Arlo"]);
    const moved = await call("POST", `/api/hub/kinwriters/${data.kinwriterId}/move`, {});
    expect(moved.data.servers.map((s: any) => s.kinwriters.map((p: any) => p.name))).toEqual([["Arlo"], ["Wren"]]);
  });
});

describe("orientation in a hub", () => {
  test("only the kinwriter orienting is unavailable; the others work, and their card says so", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    const wren = (await call("POST", `/api/hub/servers/${serverId}/kinwriters`, { name: "Wren" })).data.kinwriterId;
    // First their practice world (unreadable here: the built-in one is used), then their turn.
    fake.replies.push({ content: "(no world)" }, { content: "[nothing]" });
    await call("POST", "/p/home/api/orientation/start", { version: "full" });
    for (let i = 0; i < 200 && fake.requests.length < 2; i++) await Bun.sleep(5);
    for (let i = 0; i < 200 && hub.apps.get("home")!.kinwriter.busyChannels().length > 0; i++) await Bun.sleep(5);
    const kinwriters = (await call("GET", "/api/hub")).data.servers[0].kinwriters;
    expect(kinwriters.map((f: any) => [f.name, f.orienting])).toEqual([["Arlo", true], ["Wren", false]]);
    // Wren works as ever.
    const wrenOoc = hub.apps.get(wren)!.store.listChannels().find((c) => c.kind === "ooc")!;
    fake.replies.push({ content: "hi" });
    expect((await call("POST", `/p/${wren}/api/channels/${wrenOoc.id}/messages`, { content: "hey" })).status).toBe(200);
    await call("POST", "/p/home/api/orientation/finish", {});
  });
});

describe("deleting a kinwriter mid-orientation", () => {
  test("their orientation just ends; the server and everyone else keep going", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    const wren = (await call("POST", `/api/hub/servers/${serverId}/kinwriters`, { name: "Wren" })).data.kinwriterId;
    // Their practice world, then a slow turn: still writing when they're deleted.
    fake.replies.push({ content: "(no world)" }, { content: "*waves*", delayMs: 150 });
    for (let i = 0; i < 12; i++) fake.replies.push({ content: "[nothing]" });
    await call("POST", `/p/${wren}/api/orientation/start`, { version: "returning" });
    for (let i = 0; i < 200 && fake.requests.length < 2; i++) await Bun.sleep(5);
    expect((await call("DELETE", `/api/hub/kinwriters/${wren}`)).status).toBe(200);
    // The slow turn comes back to a closed store: nothing is thrown.
    await Bun.sleep(300);
    expect(hub.apps.has(wren)).toBe(false);
    fake.replies.unshift({ content: "still here" });
    const ooc = hub.apps.get("home")!.store.listChannels().find((c) => c.kind === "ooc")!;
    const reply = await call("POST", `/p/home/api/channels/${ooc.id}/messages`, { content: "hey" });
    expect(reply.status).toBe(200);
    expect(reply.data.kinwriterMessages[0].content).toBe("still here");
  });
});

describe("a kinwriter whose making fails", () => {
  test("leaves no app, no folder, and nothing in the list", async () => {
    hub.close();
    // Their identity can't be written: making them fails partway.
    hub = createHub(testConfig(dir.path, fake.baseUrl), (config) => {
      const app = createApp(config);
      if (config.kinwriterId !== "home") {
        app.store.identity.begin = () => {
          throw new Error("disk full");
        };
      }
      return app;
    });
    expect((await call("POST", "/api/hub/servers", { name: "Wren" })).status).toBe(500);
    expect([...hub.apps.keys()]).toEqual(["home"]);
    expect(existsSync(join(dir.path, "kinwriters")) ? readdirSync(join(dir.path, "kinwriters")) : []).toEqual([]);
    const { data } = await call("GET", "/api/hub");
    expect(data.servers.map((s: any) => s.kinwriters.map((f: any) => f.id))).toEqual([["home"]]);
  });
});

describe("shared settings", () => {
  test("two saves at once on different kinwriters: everyone ends up agreeing", async () => {
    const wren = (await call("POST", "/api/hub/servers", { name: "Wren" })).data.kinwriterId;
    const sol = (await call("POST", "/api/hub/servers", { name: "Sol" })).data.kinwriterId;
    await Promise.all([
      call("PUT", "/api/settings", { decisionConfidence: 0.6 }),
      call("PUT", `/p/${wren}/api/settings`, { decisionConfidence: 0.7 }),
      call("PUT", `/p/${sol}/api/settings`, { decisionConfidence: 0.8 }),
    ]);
    const values = [...hub.apps.values()].map((a) => a.store.getSettings().decisionConfidence);
    expect(new Set(values).size).toBe(1);
  });
});

describe("servers", () => {
  test("rename, reorder, and it's all kept", async () => {
    const first = (await call("GET", "/api/hub")).data.servers[0].id;
    const second = (await call("POST", "/api/hub/servers", { name: "Wren", serverName: "Wren's nest" })).data.server.id;
    await call("PATCH", `/api/hub/servers/${first}`, { name: "Home" });
    await call("PUT", "/api/hub/servers/order", { ids: [second, first] });
    hub.close();
    hub = createHub(testConfig(dir.path, fake.baseUrl));
    const { data } = await call("GET", "/api/hub");
    expect(data.servers.map((s: any) => s.name)).toEqual(["Wren's nest", "Home"]);
    expect(hub.apps.size).toBe(2);
  });

  test("deleting moves files to the trash; the last can't go", async () => {
    const serverId = (await call("GET", "/api/hub")).data.servers[0].id;
    expect((await call("DELETE", `/api/hub/servers/${serverId}`, {})).status).toBe(400);
    expect((await call("DELETE", "/api/hub/kinwriters/home", {})).status).toBe(400);
    const wren = (await call("POST", "/api/hub/servers", { name: "Wren" })).data;
    const gone = await call("DELETE", `/api/hub/servers/${wren.server.id}`, {});
    expect(gone.data.servers).toHaveLength(1);
    expect(existsSync(join(dir.path, "kinwriters", wren.kinwriterId))).toBe(false);
    expect(readdirSync(join(dir.path, "trash")).some((d) => d.startsWith(wren.kinwriterId))).toBe(true);
    // The first kinwriter too (their files move out of the data folder).
    const again = (await call("POST", "/api/hub/servers", { name: "Wren" })).data.kinwriterId;
    await call("DELETE", "/api/hub/kinwriters/home", {});
    expect(existsSync(join(dir.path, "kinaera.db"))).toBe(false);
    // Unprefixed requests now reach the remaining kinwriter.
    expect((await call("GET", "/api/state")).data.settings.kinwriterName).toBe("Wren");
    expect(JSON.parse(readFileSync(join(dir.path, "hub.json"), "utf8")).kinwriters.map((p: any) => p.id)).toEqual([again]);
  });

  test("bad input", async () => {
    expect((await call("POST", "/api/hub/servers", { name: "" })).status).toBe(400);
    expect((await call("PATCH", "/api/hub/servers/nope", { name: "x" })).status).toBe(404);
    expect((await call("PUT", "/api/hub/servers/order", { ids: [] })).status).toBe(400);
    const response = await hub.fetch(new Request("http://localhost/api/hub/servers", { method: "POST", body: "x" }));
    expect(response.status).toBe(415);
  });
});

describe("who it answers to", () => {
  test("localhost and IP addresses, not other names (DNS rebinding)", async () => {
    for (const host of ["localhost:4747", "127.0.0.1:4747", "[::1]:4747", "192.168.1.20:4747", "LOCALHOST"]) expect(allowedHost(host)).toBe(true);
    for (const host of ["evil.example:4747", "127.0.0.1.evil.example", ""]) expect(allowedHost(host)).toBe(false);
    expect(allowedHost("phone.tail1234.ts.net:4747", ["phone.tail1234.ts.net"])).toBe(true);
    const refused = await hub.fetch(new Request("http://evil.example:4747/api/state"));
    expect(refused.status).toBe(421);
  });
});
