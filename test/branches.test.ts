/**
 * Tests for branches: going back to an earlier message keeps what came
 * after it as a branch you can return to, regenerating an earlier reply
 * branches too, and an earlier version of a regenerated reply can come back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../src/server.ts";
import type { Channel, Message } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story] = app.store.listChannels() as [Channel];
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const say = (author: "user" | "friend", content: string): Message =>
  app.store.addTurn([{ channelId: story.id, author, content }])[0]!;

const chat = () => app.store.getMessages(story.id).map((m) => m.content);

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

describe("going back to a message", () => {
  test("sets aside what came after it as a branch, and you can return to it", async () => {
    const a = say("user", "A");
    say("friend", "B");
    say("user", "C");
    const { status, data } = await call("POST", `/api/messages/${a.id}/branch`, {});
    expect(status).toBe(200);
    expect(data.messages.map((m: Message) => m.content)).toEqual(["A"]);
    expect(data.branches).toHaveLength(1);
    expect(data.branches[0]).toMatchObject({ forkId: a.id, count: 2, first: { content: "B" }, last: { content: "C" } });

    // A new direction, then back to the first one: the new one is kept too.
    say("friend", "B2");
    const back = await call("POST", `/api/channels/${story.id}/branches/switch`, { branchId: data.branches[0].id });
    expect(back.data.messages.map((m: Message) => m.content)).toEqual(["A", "B", "C"]);
    expect(back.data.branches.map((b: { first: Message }) => b.first.content)).toEqual(["B2"]);
    expect(app.store.interventions.recent().map((e) => e.kind)).toEqual(["branch", "branch"]);
  });

  test("branches inside a branch come and go with it", async () => {
    const a = say("user", "A");
    const b = say("friend", "B");
    say("user", "C");
    app.store.branchFrom(b.id); // at B: [C]
    say("user", "C2");
    const outer = app.store.branchFrom(a.id)!; // at A: [B, C2]
    expect(app.store.branches(story.id).map((x) => x.forkId)).toEqual([a.id]);
    say("friend", "Z");
    app.store.switchBranch(outer.id);
    expect(chat()).toEqual(["A", "B", "C2"]);
    // Both are reachable again: [C] at B, and [Z] at A.
    const branches = app.store.branches(story.id);
    expect(branches.map((x) => [x.forkId, x.first.content])).toEqual([
      [b.id, "C"],
      [a.id, "Z"],
    ]);
    app.store.switchBranch(branches[0]!.id);
    expect(chat()).toEqual(["A", "B", "C"]);
  });

  test("branched messages leave the prompt", async () => {
    const a = say("user", "I knock.");
    say("friend", "Nobody answers.");
    app.store.branchFrom(a.id);
    fake.replies.push({ content: "The door opens." });
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).not.toContain("Nobody answers.");
    expect(chat()).toEqual(["I knock.", "The door opens."]);
  });

  test("deleting the message a branch follows moves the branch to the one before", async () => {
    const a = say("user", "A");
    const b = say("friend", "B");
    say("user", "C");
    app.store.branchFrom(b.id);
    app.store.deleteMessage(b.id);
    expect(app.store.branches(story.id).map((x) => [x.forkId, x.first.content])).toEqual([[a.id, "C"]]);
  });

  test("going back from the last message does nothing", async () => {
    const a = say("user", "A");
    expect(app.store.branchFrom(a.id)).toBeNull();
    expect(app.store.branches(story.id)).toEqual([]);
  });
});

describe("regenerating an earlier reply", () => {
  test("branches after it, and replaces it", async () => {
    say("user", "I knock.");
    fake.replies.push({ content: "Nobody answers." }, { content: "The door opens." });
    const first = await call("POST", `/api/channels/${story.id}/turn`, {});
    say("user", "I knock again.");
    const { status, data } = await call("POST", `/api/channels/${story.id}/regenerate`, { messageId: first.data.kinwriterMessages[0].id });
    expect(status).toBe(200);
    expect(data.branched).toBe(true);
    expect(chat()).toEqual(["I knock.", "The door opens."]);
    // The branch follows the old reply, so it shows again only with that reply.
    expect(app.store.branches(story.id)).toEqual([]);
    app.store.useAlternate(first.data.kinwriterMessages[0].id);
    expect(chat()).toEqual(["I knock.", "Nobody answers."]);
    const [branch] = app.store.branches(story.id);
    app.store.switchBranch(branch!.id);
    expect(chat()).toEqual(["I knock.", "Nobody answers.", "I knock again."]);
  });

  test("if it fails, what came after comes back", async () => {
    say("user", "I knock.");
    fake.replies.push({ content: "Nobody answers." });
    const first = await call("POST", `/api/channels/${story.id}/turn`, {});
    say("user", "I knock again.");
    fake.replies.push({ status: 400, error: "down" });
    const { status } = await call("POST", `/api/channels/${story.id}/regenerate`, { messageId: first.data.kinwriterMessages[0].id });
    expect(status).not.toBe(200);
    expect(chat()).toEqual(["I knock.", "Nobody answers.", "I knock again."]);
    expect(app.store.branches(story.id)).toEqual([]);
  });
});

describe("bringing back an earlier version of a reply", () => {
  test("swaps it in, and every version stays an alternate of whichever is shown", async () => {
    say("user", "I knock.");
    fake.replies.push({ content: "One." }, { content: "Two." }, { content: "Three." });
    const one = (await call("POST", `/api/channels/${story.id}/turn`, {})).data.kinwriterMessages[0];
    await call("POST", `/api/channels/${story.id}/regenerate`, {});
    await call("POST", `/api/channels/${story.id}/regenerate`, {});
    expect(app.store.lastMessage(story.id)!.alternates).toBe(2);

    const { status, data } = await call("POST", `/api/messages/${one.id}/use`, {});
    expect(status).toBe(200);
    expect(data.messages.map((m: Message) => m.content)).toEqual(["I knock.", "One."]);
    const shown = app.store.lastMessage(story.id)!;
    expect(shown.alternates).toBe(2);
    expect(app.store.history(shown.id).alternates.map((m) => m.content)).toEqual(["Two.", "Three."]);

    // And a regeneration after that keeps all three.
    fake.replies.push({ content: "Four." });
    await call("POST", `/api/channels/${story.id}/regenerate`, {});
    expect(app.store.history(app.store.lastMessage(story.id)!.id).alternates.map((m) => m.content)).toEqual(["One.", "Two.", "Three."]);
  });

  test("only a replaced reply can come back", async () => {
    const m = say("friend", "Hi.");
    expect((await call("POST", `/api/messages/${m.id}/use`, {})).status).toBe(400);
  });
});
