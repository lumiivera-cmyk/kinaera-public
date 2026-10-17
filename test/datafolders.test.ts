/**
 * Tests for your data folders (src/datafolders.ts), in the developer panel:
 * starting fresh from the app, the old folders and their kinwriters
 * (browsed read-only), and exporting and importing a kinwriter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import { serverState } from "../src/datafolders.ts";
import { SETUP_PENDING } from "../src/store.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;
let dataDir: string;

// A tiny PNG, for a custom emoji.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  // A folder inside the temp folder, so the old folders land next to it there.
  dataDir = join(dir.path, "data");
  hub = createHub(testConfig(dataDir, fake.baseUrl, { developerPanel: true }));
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
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}

const home = () => hub.apps.get("home")!;

/** Give the home kinwriter a name, a message and an emoji, so there's something to find later. */
function liveIn() {
  const store = home().store;
  store.updateSettings({ kinwriterName: "Wren" });
  const story = store.listChannels().find((c) => c.kind === "rp")!;
  store.addTurn([{ channelId: story.id, author: "kinwriter", content: "*The OLD-FOLDER lighthouse blinks.*" }]);
  store.reactions.addEmoji("blob_wave", PNG);
  return story;
}

describe("data folders", () => {
  test("only with the developer panel", async () => {
    hub.close();
    hub = createHub(testConfig(dataDir, fake.baseUrl));
    expect((await call("GET", "/api/hub/dev/folders")).status).toBe(404);
  });

  test("start fresh from the app: the old folder is set aside, yours carries over", async () => {
    liveIn();
    const profiles = home().store.profiles.list().length;
    const { status, data } = await call("POST", "/api/hub/dev/fresh", {});
    expect(status).toBe(200);
    expect(data.aside).toMatch(/^data-old-/);
    expect(existsSync(join(dir.path, data.aside, "kinaera.db"))).toBe(true);
    // A new kinwriter to make, with your profiles.
    expect(home().store.appState.get(SETUP_PENDING)).toBe("1");
    expect(home().store.profiles.list()).toHaveLength(profiles);
    expect(JSON.stringify(home().store.listChannels().map((c) => home().store.getMessages(c.id)))).not.toContain("OLD-FOLDER");
    // The old folder is listed, with its kinwriter.
    const folders = (await call("GET", "/api/hub/dev/folders")).data;
    expect(folders.old).toHaveLength(1);
    expect(folders.old[0].kinwriters[0]).toMatchObject({ id: "home", name: "Wren", archived: false });
    expect(folders.old[0].kinwriters[0].messages).toBeGreaterThan(0);
  });

  test("start fresh: the shared settings carry over, not what was just the first kinwriter's own", async () => {
    await call("PUT", "/api/settings", { heartbeatHours: 6, historyLimit: 40 });
    await call("PUT", "/api/hub/kinwriters/home/own", { group: "reaching", own: true });
    await call("PUT", "/api/settings", { heartbeatHours: 2 });
    expect(home().store.getSettings().heartbeatHours).toBe(2);
    await call("POST", "/api/hub/dev/fresh", {});
    expect(home().store.getSettings()).toMatchObject({ heartbeatHours: 6, historyLimit: 40 });
    // A kinwriter made next gets the shared value too.
    const made = (await call("POST", "/api/hub/servers", { name: "Sol", prompt: "You are Sol." })).data.kinwriterId;
    expect(hub.apps.get(made)!.store.getSettings().heartbeatHours).toBe(6);
  });

  test("start fresh with the first kinwriter deleted: profiles come from the next one", async () => {
    const sol = (await call("POST", "/api/hub/servers", { name: "Sol" })).data.kinwriterId;
    await call("POST", `/p/${sol}/api/profiles`, { name: "Kept-Profile", model: "zeta/model" });
    expect((await call("DELETE", "/api/hub/kinwriters/home", {})).status).toBe(200);
    const { status, data } = await call("POST", "/api/hub/dev/fresh", {});
    expect(status).toBe(200);
    expect(home().store.profiles.list().map((p) => p.name)).toContain("Kept-Profile");
    // Nothing was made in the folder set aside.
    expect(existsSync(join(dir.path, data.aside, "kinaera.db"))).toBe(false);
  });

  test("start fresh with the first kinwriter archived: the profiles they missed carry over", async () => {
    const sol = (await call("POST", "/api/hub/servers", { name: "Sol" })).data.kinwriterId;
    await call("PUT", "/api/hub/servers/order", { ids: [...hub.servers().map((s) => s.id)].reverse() });
    expect((await call("POST", "/api/hub/kinwriters/home/archive", {})).status).toBe(200);
    await call("POST", `/p/${sol}/api/profiles`, { name: "Newer-Profile", model: "zeta/model" });
    expect((await call("POST", "/api/hub/dev/fresh", {})).status).toBe(200);
    expect(home().store.profiles.list().map((p) => p.name)).toContain("Newer-Profile");
  });

  test("start fresh that fails: everyone is back, and the app still answers", async () => {
    liveIn();
    // No kinwriter's database to start from.
    for (const name of ["kinaera.db", "kinaera.db-wal", "kinaera.db-shm"]) rmSync(join(dataDir, name), { force: true });
    expect((await call("POST", "/api/hub/dev/fresh", {})).status).toBe(400);
    expect(hub.apps.has("home")).toBe(true);
    expect((await call("GET", "/api/hub")).status).toBe(200);
    expect((await call("GET", "/api/state")).status).toBe(200);
  });

  test("browsing a current kinwriter shows them as they are now", async () => {
    const story = liveIn();
    const path = `/api/hub/dev/folders/current/kinwriters/home/channels/${story.id}`;
    expect((await call("GET", path)).data.messages).toHaveLength(1);
    home().store.addTurn([{ channelId: story.id, author: "kinwriter", content: "A NEWER line." }]);
    expect((await call("GET", path)).data.messages.map((m: any) => m.content)).toContain("A NEWER line.");
  });

  test("bun run fresh: only a refused connection counts as stopped", async () => {
    const listening = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = listening.port!;
    expect(await serverState("127.0.0.1", port)).toBe("running");
    expect(await serverState("0.0.0.0", port)).toBe("running");
    listening.stop(true);
    expect(await serverState("127.0.0.1", port)).toBe("stopped");
  });

  test("browse an old kinwriter read-only, then bring them back as a new kinwriter", async () => {
    const story = liveIn();
    const { data: fresh } = await call("POST", "/api/hub/dev/fresh", {});
    const folder = fresh.aside;
    const before = readdirSync(join(dir.path, folder)).sort();
    const browsed = (await call("GET", `/api/hub/dev/folders/${folder}/kinwriters/home`)).data;
    expect(browsed.name).toBe("Wren");
    expect(browsed.channels.map((c: any) => c.name)).toContain("story");
    const messages = (await call("GET", `/api/hub/dev/folders/${folder}/kinwriters/home/channels/${story.id}`)).data;
    expect(messages.messages.map((m: any) => m.content)).toContain("*The OLD-FOLDER lighthouse blinks.*");
    // Browsing never changes the old folder: it reads a copy.
    expect(readdirSync(join(dir.path, folder)).sort()).toEqual(before);

    const imported = await call("POST", `/api/hub/dev/folders/${folder}/kinwriters/home/import`, {});
    expect(imported.status).toBe(200);
    const app = hub.apps.get(imported.data.kinwriterId)!;
    expect(app.store.getSettings().kinwriterName).toBe("Wren");
    expect(app.store.getMessages(story.id).map((m) => m.content)).toContain("*The OLD-FOLDER lighthouse blinks.*");
    expect(app.store.reactions.listEmojis().map((e) => e.name)).toEqual(["blob_wave"]);
    // On a server of their own.
    expect(imported.data.servers.map((s: any) => s.kinwriters.map((f: any) => f.name))).toContainEqual(["Wren"]);
  });

  test("export a kinwriter as one file, and import it", async () => {
    liveIn();
    const exported = await call("GET", "/api/hub/dev/folders/current/kinwriters/home/export");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain('filename="wren.kinwriter.json"');
    expect(exported.data).toMatchObject({ format: "kinaera-kinwriter", version: 1, name: "Wren" });
    expect(Object.keys(exported.data.emojis)).toHaveLength(1);
    const imported = await call("POST", "/api/hub/dev/import", exported.data);
    expect(imported.status).toBe(200);
    const app = hub.apps.get(imported.data.kinwriterId)!;
    expect(app.store.getSettings().kinwriterName).toBe("Wren");
    expect(existsSync(join(dataDir, "kinwriters", imported.data.kinwriterId, "emojis"))).toBe(true);
    // Something that isn't one is refused, and nothing is made.
    const kinwriters = hub.apps.size;
    expect((await call("POST", "/api/hub/dev/import", { format: "something-else" })).status).toBe(400);
    expect((await call("POST", "/api/hub/dev/import", { ...exported.data, database: Buffer.from("not a database").toString("base64") })).status).toBe(400);
    expect(hub.apps.size).toBe(kinwriters);
  });

  test("only folders it lists, and only kinwriters inside them", async () => {
    expect((await call("GET", "/api/hub/dev/folders/..%2F..%2Fetc/kinwriters/home")).status).toBe(400);
    expect((await call("GET", "/api/hub/dev/folders/current/kinwriters/nobody")).status).toBe(400);
  });
});
