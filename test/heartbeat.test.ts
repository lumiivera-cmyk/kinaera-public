/**
 * Tests for the heartbeat (src/heartbeat.ts) and notifications
 * (src/notify.ts).
 *
 * Your kinwriter's replies come from the fake nanoGPT's `replies`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Heartbeat } from "../src/heartbeat.ts";
import { setMapEntry } from "../src/toolmap.ts";
import { checkSaysYes } from "../src/kinwriter.ts";
import { Presence, PRESENCE_TIMEOUT_MS, type Notification } from "../src/notify.ts";
import { createApp, type App } from "../src/server.ts";
import { validateSettings } from "../src/store.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt, oneProfile } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;
let now: Date;
let wakeups: Wakeups;
let heartbeat: Heartbeat;
let notified: Notification[];

const HOUR = 3_600_000;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  notified = [];
  app = createApp(testConfig(dir.path, fake.baseUrl, { notifier: { available: () => true, notify: (n) => notified.push(n) } }));
  oneProfile(app.store);
  ooc = app.store.listChannels()[1]!;
  now = new Date();
  now.setHours(12, 0, 0, 0);
  wakeups = new Wakeups(app.store, app.kinwriter, true, () => now);
  wakeups.onPosted = app.wakeups.onPosted; // notifications, as the server sets them up
  heartbeat = new Heartbeat(app.store, wakeups, () => now, () => 0.5);
  settings({ heartbeatHours: 6 });
});

afterEach(() => {
  heartbeat.stop();
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

function settings(update: Record<string, unknown>) {
  app.store.updateSettings(validateSettings(update));
}

function youWrote(hoursAgo: number, content = "night!") {
  app.store.addMessage({ channelId: ooc.id, author: "user", content, createdAt: new Date(now.getTime() - hoursAgo * HOUR).toISOString() });
}

describe("pieces", () => {
  test("presence times out", () => {
    let t = 0;
    const presence = new Presence(() => t);
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    expect(presence.isVisible()).toBe(true);
    t = PRESENCE_TIMEOUT_MS + 1;
    expect(presence.isVisible()).toBe(false);
    presence.set(true);
    presence.set(false);
    expect(presence.isVisible()).toBe(false);
  });
});

describe("the heartbeat", () => {
  test("off, or not yet due: nothing", async () => {
    settings({ heartbeatHours: 0 });
    expect((await heartbeat.tick()).outcome).toBe("off");
    settings({ heartbeatHours: 6 });
    // The first check only schedules: 6 hours × (0.8 + 0.4 × 0.5) = 6 hours.
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(heartbeat.nextAt()!.getTime()).toBe(now.getTime() + 6 * HOUR);
    now = new Date(now.getTime() + 5 * HOUR);
    expect((await heartbeat.tick()).outcome).toBe("not-due");
    expect(fake.requests.length + fake.jevRequests.length).toBe(0);
  });

  test("the hard rules come first, costing nothing", async () => {
    settings({ quietStart: 10, quietEnd: 14 });
    youWrote(8);
    const beat = await heartbeat.tick(true);
    expect(beat).toMatchObject({ outcome: "blocked", detail: "It's quiet hours." });
    expect(fake.requests).toHaveLength(0);
  });

  test("a free moment: your kinwriter writes, with no Jev in the way", async () => {
    youWrote(8);
    fake.replies.push({ content: "Random thought: what if Ilse's lighthouse was the vault in a heist?" });
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("woke");
    expect(beat.wake).toMatchObject({ outcome: "posted", reason: "heartbeat" });
    // Jev never decides whether they wake; it only reads their draft for their own reflexes (src/reflexes.ts).
    expect(fake.jevRequests.every((r) => JSON.stringify(r.messages).includes("draft reply"))).toBe(true);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("A free moment");
    // You weren't looking: a notification.
    expect(notified).toEqual([
      { title: "Arlo in #ooc", text: "Random thought: what if Ilse's lighthouse was the vault in a heist?", channelId: ooc.id },
    ]);
  });

  test("a free moment your kinwriter spends quietly", async () => {
    youWrote(8);
    fake.replies.push({ content: "[nothing]" });
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "quiet", reason: "heartbeat" });
    expect(notified).toEqual([]);
  });

  test("no notification while the app is on screen", async () => {
    app.presence.set(true);
    youWrote(8);
    fake.replies.push({ content: "Hi!" });
    await heartbeat.tick(true);
    expect(notified).toEqual([]);
  });

  test("the heartbeat check says not now: the main model is never asked", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}` });
    youWrote(8);
    fake.replies.push({ content: "NO" });
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "quiet", reason: "heartbeat" });
    expect(beat.wake!.detail).toContain("heartbeat check said not now (Cheap)");
    expect(fake.requests.map((r) => r.model)).toEqual(["cheap/model"]);
    // It read the same free moment, with the question after it, and no tools.
    const asked = JSON.stringify(fake.requests[0]!.messages);
    expect(asked).toContain("A free moment");
    expect(asked).toContain("Answer with one word");
    expect(fake.requests[0]!.tools ?? []).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("the heartbeat check says yes: then the main model takes the moment", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}` });
    youWrote(8);
    fake.replies.push({ content: "Yes." }, { content: "Thinking of you!" });
    const beat = await heartbeat.tick(true);
    expect(beat.wake).toMatchObject({ outcome: "posted", reason: "heartbeat" });
    expect(beat.wake!.detail).toContain("said yes first");
    expect(fake.requests[0]!.model).toBe("cheap/model");
    expect(fake.requests[1]!.model).not.toBe("cheap/model");
    expect(notified).toHaveLength(1);
  });

  test("a no from the check isn't a turn: it holds back no other wake-up", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}`, wakeups: "chatty" });
    youWrote(8);
    fake.replies.push({ content: "NO" }, { content: "Hey, you're back!" });
    await heartbeat.tick(true);
    // Logged, so you can see it...
    expect(app.store.wakeLog.recent()[0]).toMatchObject({ reason: "heartbeat", outcome: "quiet" });
    // ...but the cooldown doesn't count from it.
    expect(app.store.wakeLog.lastTurnAt()).toBeNull();
    expect((await wakeups.event("opened")).outcome).toBe("posted");
  });

  test("the check is asked without tool guidance, even when its profile could use tools", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model", supportsTools: true });
    settings({ heartbeatAssignment: `profile:${cheap.id}` });
    youWrote(8);
    fake.replies.push({ content: "NO" });
    await heartbeat.tick(true);
    const asked = JSON.stringify(fake.requests[0]!.messages);
    expect(asked).not.toContain("## Tools");
    expect(asked).not.toContain("do_nothing");
    expect(asked).toContain("Answer with one word");
  });

  test("the check reads a short prompt: what the decision needs, not the whole turn", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}` });
    app.store.notebook.createEntry("user", { kind: "lore", name: "The Drowned Bell", fields: [{ label: "What", value: "A bell under the lighthouse." }] });
    app.store.journal.write("JOURNAL-THOUGHT");
    setMapEntry(app.store, "write_journal", "when a thought won't leave me alone");
    for (let i = 0; i < 20; i++) youWrote(30 - i, `message ${i}`);
    fake.replies.push({ content: "NO" }, { content: "Hi!" });
    await heartbeat.tick(true);
    const check = fake.requests[0]!.messages;
    const asked = JSON.stringify(check);
    // Who they are, why they're up, the time, and the question.
    expect(asked).toContain("## Who you are");
    expect(asked).toContain("A free moment");
    expect(asked).toContain("## Your time");
    expect(asked).toContain("Answer with one word");
    // What they could do with it: their tools, by name, but none sent.
    expect(asked).toContain("## Your tools");
    expect(asked).toContain("write_journal: when a thought won't leave me alone");
    expect(fake.requests[0]!.tools ?? []).toEqual([]);
    // Only the last 8 messages.
    expect(asked).toContain("message 19");
    expect(asked).toContain("message 12");
    expect(asked).not.toContain("message 11");
    // Nothing that only helps a turn write.
    for (const left of ["The Drowned Bell", "JOURNAL-THOUGHT", "## Channels on your server", "## Good to know", "## Tools"]) {
      expect(asked).not.toContain(left);
    }

    // The same beat without a check: the full prompt is far longer.
    settings({ heartbeatAssignment: "" });
    await heartbeat.tick(true);
    const full = fake.requests[1]!;
    expect(JSON.stringify(full.messages)).toContain("The Drowned Bell");
    // What the turn reads: its prompt and its tools' full descriptions.
    const fullSize = JSON.stringify(full.messages).length + JSON.stringify(full.tools).length;
    expect(JSON.stringify(check).length).toBeLessThan(fullSize / 4);
  });

  test("the rules are checked again after the check says yes", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}` });
    youWrote(8);
    fake.replies.push({ content: "YES", delayMs: 100 });
    const beating = heartbeat.tick(true);
    await Bun.sleep(30);
    // You write while the check is being asked: now it's a conversation.
    youWrote(0);
    const beat = await beating;
    expect(beat.outcome).toBe("blocked");
    expect(beat.detail).toContain("You were talking just now");
    expect(fake.requests.map((r) => r.model)).toEqual(["cheap/model"]);
  });

  test("another wake-up running: the beat says it was skipped, not that it woke", async () => {
    youWrote(8);
    fake.replies.push({ content: "first", delayMs: 100 });
    const first = wakeups.event("heartbeat");
    await Bun.sleep(20);
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("skipped");
    await first;
  });

  test("talk that isn't with you doesn't count as mid-conversation", async () => {
    youWrote(8);
    const practice = app.store.ensurePractice();
    const recent = new Date(now.getTime() - 60_000).toISOString();
    // Their own time in the practice channel, and another kinwriter in #ooc, a minute ago.
    app.store.addMessage({ channelId: practice.id, author: "kinwriter", content: "practising", createdAt: recent });
    app.store.addMessage({ channelId: ooc.id, author: "peer", content: "hi Arlo", createdAt: recent, speaker: { id: "p1", name: "Wren" } } as never);
    fake.replies.push({ content: "Hi!" });
    expect((await heartbeat.tick(true)).outcome).toBe("woke");
  });

  test("only a clear yes counts", () => {
    expect(checkSaysYes("YES")).toBe(true);
    expect(checkSaysYes("Hmm. Yes, I'd text them.")).toBe(true);
    expect(checkSaysYes("No, not yet: yes later maybe")).toBe(false);
    expect(checkSaysYes("yesterday was fine")).toBe(false);
    expect(checkSaysYes("")).toBe(false);
  });

  test("other wake-ups skip the check", async () => {
    const cheap = app.store.profiles.create({ name: "Cheap", model: "cheap/model" });
    settings({ heartbeatAssignment: `profile:${cheap.id}`, wakeups: "chatty" });
    youWrote(8);
    fake.replies.push({ content: "Hey, you're back!" });
    const wake = await wakeups.event("opened");
    expect(wake.outcome).toBe("posted");
    expect(fake.requests.every((r) => r.model !== "cheap/model")).toBe(true);
  });

  test("never mid-conversation", async () => {
    youWrote(0.1);
    const beat = await heartbeat.tick(true);
    expect(beat.outcome).toBe("blocked");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the API", () => {
  async function call(method: string, path: string, body?: unknown) {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, data: (await response.json()) as any };
  }

  test("presence, state, settings", async () => {
    expect((await call("POST", "/api/presence", { visible: true })).status).toBe(200);
    expect(app.presence.isVisible()).toBe(true);
    const state = (await call("GET", "/api/state")).data;
    expect(state.notifications).toBe(true);
    // As short as every 5 minutes, and no shorter.
    expect((await call("PUT", "/api/settings", { heartbeatHours: 0.1667 })).status).toBe(200);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 0.05 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { heartbeatHours: 200 })).status).toBe(400);
  });

  test("beat now", async () => {
    // Chattiness off, so nothing is spent.
    settings({ wakeups: "off" });
    const { data } = await call("POST", "/api/heartbeat", {});
    expect(data.beat.outcome).toBe("blocked");
  });
});
