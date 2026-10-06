/**
 * Tests for editing the prompts' wording in the app, and the dry run
 * (src/wording.ts, the hub's /api/hub/prompts, Kinwriter.dryRun and
 * /api/dry-run).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import { rpFraming } from "../src/prompt.ts";
import { fill, setWordingOverrides, wording } from "../src/wording.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  hub = createHub(testConfig(dir.path, fake.baseUrl));
  hub.apps.get("home")!.store.appState.set("orientation.pending", null);
});

afterEach(() => {
  hub.close();
  fake.stop();
  dir.cleanup();
  setWordingOverrides(null);
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

const store = () => hub.apps.get("home")!.store;
const channel = (kind: string) => store().listChannels().find((c) => c.kind === kind)!;

describe("editing the wording", () => {
  test("every file is listed, with its sections and defaults", async () => {
    const { data } = await call("GET", "/api/hub/prompts");
    const turns = data.files.find((f: any) => f.file === "turns");
    expect(turns.about).toContain("The framing of every turn");
    expect(turns.sections.find((s: any) => s.name === "rp-framing")).toMatchObject({ edited: false });
    expect(data.files.map((f: any) => f.file)).toEqual(expect.arrayContaining(["summaries", "surprise", "jev", "standing", "orientation"]));
  });

  test("an edit is used on the next turn, kept apart from defaults/, and can be reset", async () => {
    const original = rpFraming();
    const { data } = await call("PUT", "/api/hub/prompts/turns/rp-framing", { text: "You are the co-author." });
    expect(data.files.find((f: any) => f.file === "turns").sections.find((s: any) => s.name === "rp-framing")).toMatchObject({ edited: true, text: "You are the co-author." });
    expect(rpFraming()).toBe("You are the co-author.");
    expect(JSON.parse(readFileSync(join(dir.path, "prompts.json"), "utf8"))).toEqual({ turns: { "rp-framing": "You are the co-author." } });

    // In a real turn's prompt.
    await call("POST", `/api/channels/${channel("rp").id}/turn`, {});
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain("You are the co-author.");

    await call("DELETE", "/api/hub/prompts/turns/rp-framing");
    expect(rpFraming()).toBe(original);
    expect(JSON.parse(readFileSync(join(dir.path, "prompts.json"), "utf8"))).toEqual({});
  });

  test("saving the default text is the same as resetting; unknown sections are refused", async () => {
    await call("PUT", "/api/hub/prompts/turns/new-scene", { text: `  ${wording("turns")["new-scene"]}  ` });
    expect(existsSync(join(dir.path, "prompts.json")) ? JSON.parse(readFileSync(join(dir.path, "prompts.json"), "utf8")) : {}).toEqual({});
    expect((await call("PUT", "/api/hub/prompts/turns/no-such-section", { text: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/hub/prompts/../etc/passwd", { text: "x" })).status).not.toBe(200);
    expect((await call("PUT", "/api/hub/prompts/turns/new-scene", { text: 5 })).status).toBe(400);
  });

  test("placeholders are filled; unknown ones are left alone", () => {
    expect(fill('{name} said {"q1": 1} and {other}', { name: "Ilse" })).toBe('Ilse said {"q1": 1} and {other}');
  });
});

describe("the dry run", () => {
  test("builds a turn's prompt and tools without asking the model or saving anything", async () => {
    const ooc = channel("ooc");
    const before = store().getMessages(ooc.id).length;
    const { status, data } = await call("POST", "/api/dry-run", { channelId: ooc.id, turn: "turn" });
    expect(status).toBe(200);
    expect(data.messages[0].role).toBe("system");
    expect(data.tools.map((t: any) => t.name)).toContain("do_nothing");
    expect(data.reply).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(store().getMessages(ooc.id)).toHaveLength(before);
  });

  test("a wake-up shows why they're up; the look back hides the journal", async () => {
    const ooc = channel("ooc");
    const { data } = await call("POST", "/api/dry-run", { channelId: ooc.id, turn: "heartbeat" });
    expect(data.messages[0].content).toContain("## Why you're up");
    store().journal.write("SECRET-JOURNAL-LINE");
    const look = await call("POST", "/api/dry-run", { turn: "lookback" });
    expect(look.data.channel.kind).toBe("practice");
    expect(JSON.stringify(look.data)).not.toContain("SECRET-JOURNAL-LINE");
    const orientation = await call("POST", "/api/dry-run", { turn: "orientation" });
    expect(orientation.data.messages[0].content).toContain("## Why you're up");
    expect((await call("POST", "/api/dry-run", { channelId: ooc.id, turn: "nonsense" })).status).toBe(400);
  });

  test("with send: the model's reply and the tools it would call, none run, nothing saved", async () => {
    const ooc = channel("ooc");
    const before = store().getMessages(ooc.id).length;
    fake.replies.push({ toolCalls: [{ name: "write_journal", arguments: { text: "PRIVATE-THOUGHT" } }, { name: "create_channel", arguments: { name: "heist" } }], content: "Want to plan a heist?" });
    const { data } = await call("POST", "/api/dry-run", { channelId: ooc.id, turn: "turn", send: true });
    expect(data.reply.content).toBe("Want to plan a heist?");
    expect(data.reply.toolCalls).toEqual([
      { name: "write_journal", arguments: "(private)" },
      { name: "create_channel", arguments: JSON.stringify({ name: "heist" }) },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(store().getMessages(ooc.id)).toHaveLength(before);
    expect(store().listChannels().some((c) => c.name === "heist")).toBe(false);
    expect(store().journal.since(new Date(0).toISOString())).toEqual([]);
  });
});
