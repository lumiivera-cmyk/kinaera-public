/**
 * Tests for reflexes (src/reflexes.ts): your kinwriter's quick double-check
 * on their own follow-through, with Jev reading their draft.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allReflexes } from "../src/reflexes.ts";
import { createApp, type App } from "../src/server.ts";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { runTool } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  ooc = app.store.listChannels().find((c) => c.kind === "ooc")!;
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

/** Jev's answer: a confident yes to the checks named, a confident no to the rest. */
function jevSays(yes: string[]) {
  fake.jevReplies.push({
    content: JSON.stringify({
      answers: Object.fromEntries(
        allReflexes().flatMap((r) =>
          [0, 1].map((i) => [`${r.id}~${i}`, yes.includes(r.id) ? { choice: "yes", probabilities: { yes: 0.97, no: 0.03 } } : { choice: "no", probabilities: { yes: 0.03, no: 0.97 } }]),
        ),
      ),
    }),
  });
}

async function say(content: string) {
  const response = await app.fetch(
    new Request(`http://localhost/api/channels/${ooc.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }),
  );
  return (await response.json()) as any;
}

describe("reflexes", () => {
  test("they said they'd come back later without a wake-up: one reminder, one more round, their call", async () => {
    fake.replies.push(
      { content: "I'll check in tomorrow about the heist!" },
      { toolCalls: [{ name: "schedule_wakeup", arguments: { when: "tomorrow 18:00", note: "ask about the heist" } }] },
      { content: "[same]" },
    );
    jevSays(["later"]);
    await say("let's plan a heist");
    // Jev read the draft, not the decision.
    expect(JSON.stringify(fake.jevRequests[0]!.messages)).toContain("I'll check in tomorrow about the heist!");
    // The reminder was their next note, and they acted on it.
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain("You only get a turn for it if you set a wake-up");
    expect(app.store.schedule.waiting()).toHaveLength(1);
    // "[same]": the draft is posted as it was.
    expect(app.store.getMessages(ooc.id).at(-1)!.content).toBe("I'll check in tomorrow about the heist!");
    // You see that they were reminded.
    expect(app.store.toolLog.forChannel(ooc.id).map((c) => c.name)).toEqual(["reflex", "schedule_wakeup"]);
  });

  test("nothing came up: the draft is posted, with no extra round", async () => {
    fake.replies.push({ content: "Sounds fun." });
    jevSays([]);
    await say("let's plan a heist");
    expect(fake.requests).toHaveLength(1);
    expect(app.store.getMessages(ooc.id).at(-1)!.content).toBe("Sounds fun.");
  });

  test("they can rewrite after a reminder, and a check is skipped when they already used its tool", async () => {
    fake.replies.push({ content: "Fixed that typo in the scene!" }, { content: "Oops, I haven't fixed it yet. Doing it next turn." });
    jevSays(["edited"]);
    await say("there's a typo in your post");
    expect(app.store.getMessages(ooc.id).at(-1)!.content).toBe("Oops, I haven't fixed it yet. Doing it next turn.");
    // Already scheduled this turn: the "later" check isn't asked.
    fake.replies.push({ toolCalls: [{ name: "schedule_wakeup", arguments: { when: "tomorrow 18:00", note: "x" } }] }, { content: "Set for tomorrow." });
    jevSays([]);
    await say("remind yourself tomorrow");
    const asked = Object.keys(fake.jevRequests.at(-1)!.response_format.questions);
    expect(asked.some((id) => id.startsWith("later~"))).toBe(false);
  });

  test("their instrument: listed, turned off by them, and told in their prompt", async () => {
    const ctx = { store: app.store, channel: ooc, mode: "post" as const, decider: app.kinwriter.decider ?? undefined };
    const list = await runTool(ctx, "set_my_reflexes", {});
    expect((list.result as any[]).map((r) => r.check)).toEqual(expect.arrayContaining(["edited", "later", "lore"]));
    await runTool(ctx, "set_my_reflexes", { check: "later", on: false });
    fake.replies.push({ content: "I'll check in tomorrow!" });
    jevSays([]);
    await say("bye");
    expect(Object.keys(fake.jevRequests.at(-1)!.response_format.questions).some((id) => id.startsWith("later~"))).toBe(false);
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("You keep a quick double-check on your own follow-through");
  });
});

describe("after a reminder, they choose on purpose", () => {
  test("the round after a reminder requires a tool: theirs, or keep_my_draft", async () => {
    fake.replies.push(
      { content: "I'll check in tomorrow about the heist!" },
      { toolCalls: [{ name: "schedule_wakeup", arguments: { when: "tomorrow 18:00", note: "the heist" } }] },
      { content: "[same]" },
    );
    jevSays(["later"]);
    await say("let's plan a heist");
    const deciding = fake.requests[1] as any;
    expect(deciding.tool_choice).toBe("required");
    expect(deciding.tools.map((t: any) => t.function.name)).toContain("keep_my_draft");
    expect((fake.requests[2] as any).tool_choice).toBe("auto");
    // They acted: no flag, and the log says so.
    const reflex = app.store.toolLog.forChannel(ooc.id).find((c) => c.name === "reflex")!;
    expect(reflex.summary).toContain("was reminded by Jev (later) and acted on later");
    expect(JSON.parse(reflex.result).flagged).toEqual([]);
  });

  test("keep_my_draft posts the draft as it was, and you see that they didn't act", async () => {
    fake.replies.push({ content: "Fixed that typo in the scene!" }, { toolCalls: [{ name: "keep_my_draft", arguments: { reason: "I meant my own notes" } }] });
    jevSays(["edited"]);
    await say("there's a typo in your post");
    expect(app.store.getMessages(ooc.id).at(-1)!.content).toBe("Fixed that typo in the scene!");
    const reflex = app.store.toolLog.forChannel(ooc.id).find((c) => c.name === "reflex")!;
    expect(reflex.summary).toContain("posted without acting on edited");
    expect(JSON.parse(reflex.result)).toMatchObject({ flagged: ["changed an earlier message"], kept: "I meant my own notes" });
    expect(app.store.toolLog.forChannel(ooc.id).map((c) => c.name)).toContain("keep_my_draft");
  });

  test("a provider that ignores the requirement: [same] with no action is flagged too", async () => {
    fake.replies.push({ content: "Posted it in #story!" }, { content: "[same]" });
    jevSays(["posted"]);
    await say("can you start the scene?");
    expect(JSON.parse(app.store.toolLog.forChannel(ooc.id).find((c) => c.name === "reflex")!.result).flagged).toEqual(["posted in another channel"]);
  });
});

describe("reflexes ask only what they can answer", () => {
  test("not on story posts: a character saying \"I fixed it\" is fiction", async () => {
    const story = app.store.listChannels().find((c) => c.kind === "rp")!;
    fake.replies.push({ content: '"I fixed the lamp," Ilse says. "I\'ll check the nets tomorrow."' });
    jevSays(["edited", "later"]);
    await app.fetch(new Request(`http://localhost/api/channels/${story.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "*Kestrel waits.*" }) }));
    // The chance checks start off, and the follow-through ones stay out of stories: nothing to ask.
    expect(fake.jevRequests).toHaveLength(0);
    expect(app.store.getMessages(story.id).at(-1)!.content).toContain("I fixed the lamp");
  });

  test("something they did in the last half hour counts: a true \"I fixed that\" isn't asked about", async () => {
    app.store.toolLog.add({ channelId: ooc.id, turnId: "earlier", round: 0, name: "edit_my_message", arguments: "{}", result: "{}", status: "ok", summary: "edited their message in #story", source: "native", profile: null } as any);
    fake.replies.push({ content: "Fixed that typo earlier!" });
    jevSays([]);
    await say("thanks");
    const request = fake.jevRequests.at(-1)!;
    expect(Object.keys(request.response_format.questions).some((id) => id.startsWith("edited~"))).toBe(false);
    expect(JSON.stringify(request.messages)).toContain("edited their message in #story");
  });

  test("the chance checks start off, and they can turn them on", async () => {
    const ctx = { store: app.store, channel: ooc, mode: "post" as const, decider: app.kinwriter.decider ?? undefined };
    const list = (await runTool(ctx, "set_my_reflexes", {})).result as { check: string; on: boolean }[];
    expect(list.find((r) => r.check === "lore")).toMatchObject({ on: false });
    expect(list.find((r) => r.check === "edited")).toMatchObject({ on: true });
    await runTool(ctx, "set_my_reflexes", { check: "recall", on: true });
    fake.replies.push({ content: "Ilse's brother was Tobias, right?" });
    jevSays([]);
    await say("who was the brother?");
    expect(Object.keys(fake.jevRequests.at(-1)!.response_format.questions).some((id) => id.startsWith("recall~"))).toBe(true);
  });
});

describe("no duplicate notebook entries", () => {
  const story = () => app.store.listChannels().find((c) => c.kind === "rp")!;
  const ctx = () => ({ store: app.store, channel: story(), mode: "post" as const });

  test("making one that's already there hands back the existing entry instead", async () => {
    await runTool(ctx(), "create_notebook_entry", { kind: "lore", name: "The Lantern Guild", fields: { Founded: "Long ago" } });
    const again = await runTool(ctx(), "create_notebook_entry", { kind: "lore", name: "lantern guild" });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again.result)).toContain("already an entry called");
    expect(JSON.stringify(again.result)).toContain("Long ago");
    expect(app.store.notebook.listEntries("friend").filter((e) => e.name.toLowerCase().includes("lantern guild"))).toHaveLength(1);
    expect((await runTool(ctx(), "create_notebook_entry", { kind: "lore", name: "The Lantern Guild's rival" })).ok).toBe(true);
  });

  test("an entry hidden from them doesn't block theirs (they'd learn it's there)", async () => {
    app.store.notebook.createEntry("user", { kind: "lore", name: "Harbour Secret", fields: [], visibility: "hidden" });
    expect((await runTool(ctx(), "create_notebook_entry", { kind: "lore", name: "Harbour Secret" })).ok).toBe(true);
  });

  test("in a story channel, the rest of the notebook by name, so they look it up", async () => {
    await runTool(ctx(), "create_notebook_entry", { kind: "lore", name: "The Drowned Bell", fields: { Rings: "BELL-DETAIL" } });
    const prompt = promptForChannel(app.store, story().id, { profile: pickProfile(app.store, story()) })[0]!.content;
    expect(prompt).toContain("## Also in the notebook");
    expect(prompt).toContain("The Drowned Bell (lore)");
    // Names only: its details come from reading it.
    expect(prompt).not.toContain("BELL-DETAIL");
  });

  test("Jev knows what's already in the notebook when it reads the draft", async () => {
    app.store.notebook.createEntry("friend", { kind: "character", name: "Ilse Marrow-Twin", fields: [] });
    fake.replies.push({ content: "Sounds fun." });
    jevSays([]);
    await say("hi");
    expect(JSON.stringify(fake.jevRequests.at(-1)!.messages)).toContain("Names already in the notebook:");
    expect(JSON.stringify(fake.jevRequests.at(-1)!.messages)).toContain("Ilse Marrow-Twin");
  });
});

