/**
 * Tests for rewrites (src/rewrites.ts): you suggest new words for part of
 * your kinwriter's message, and they accept or decline each one; and for
 * their tool map (src/toolmap.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mentionCandidates, pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { applyRewrite } from "../src/rewrites.ts";
import { createApp, type App } from "../src/server.ts";
import { toolMap } from "../src/toolmap.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  story = app.store.listChannels().find((c) => c.kind === "rp")!;
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

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

const ctx = (): ToolContext => ({ store: app.store, channel: story, mode: "post" });
const theirs = (content: string) => app.store.addTurn([{ channelId: story.id, author: "friend", content }])[0]!;

describe("rewrites", () => {
  test("you suggest; they see it waiting; accepting puts your words in, as their edit", async () => {
    const message = theirs("*Ilse sets the lamp down.* The sea is a cruel mistress tonight.");
    const { data } = await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "The sea is a cruel mistress tonight.", replacement: "The sea's in a mood." });
    expect(data.rewrites).toHaveLength(1);
    const prompt = promptForChannel(app.store, story.id, { profile: pickProfile(app.store, story) })[0]!.content;
    expect(prompt).toContain("## Waiting for your review");
    expect(prompt).toContain('replace "The sea is a cruel mistress tonight." with "The sea\'s in a mood."');
    const id = data.rewrites[0].id.slice(0, 8);
    const outcome = await runTool(ctx(), "review_rewrite", { rewrite: id, accept: true, note: "Ha, yes." });
    expect(outcome.ok).toBe(true);
    expect(app.store.getMessage(message.id).content).toBe("*Ilse sets the lamp down.* The sea's in a mood.");
    expect(app.store.getMessage(message.id).editedBy).toBe("friend");
    expect(app.store.history(message.id).revisions.map((r) => r.content)[0]).toContain("cruel mistress");
    // All answered: a moment to keep a craft note, not a record of mistakes.
    expect(JSON.stringify(outcome.result)).toContain("keep_pattern_note");
    expect((await call("GET", `/api/channels/${story.id}/messages`)).data.rewrites[0]).toMatchObject({ status: "accepted", note: "Ha, yes." });
  });

  test("each part on its own: one accepted, one declined", async () => {
    const message = theirs("She smiled softly. Her eyes sparkled like diamonds.");
    await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "smiled softly", replacement: "almost smiled" });
    const { data } = await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "Her eyes sparkled like diamonds.", replacement: "" });
    const [a, b] = data.rewrites;
    const first = await runTool(ctx(), "review_rewrite", { rewrite: a.id.slice(0, 8), accept: true });
    expect(JSON.stringify(first.result)).toContain("still_waiting");
    await runTool(ctx(), "review_rewrite", { rewrite: b.id.slice(0, 8), accept: false, note: "I like the sparkle." });
    expect(app.store.getMessage(message.id).content).toBe("She almost smiled. Her eyes sparkled like diamonds.");
    expect((await runTool(ctx(), "review_rewrite", { rewrite: b.id.slice(0, 8), accept: true })).ok).toBe(false);
  });

  test("only on their messages; withdrawn ones are gone from their list", async () => {
    const yours = app.store.addTurn([{ channelId: story.id, author: "user", content: "Kestrel waits." }])[0]!;
    expect((await call("POST", `/api/messages/${yours.id}/rewrites`, { quote: "waits", replacement: "lingers" })).status).toBe(400);
    const message = theirs("The tide turns.");
    const { data } = await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "turns", replacement: "comes in" });
    await call("POST", `/api/rewrites/${data.rewrite.id}/withdraw`, {});
    expect(app.store.rewrites.pending()).toEqual([]);
  });

  test("words that aren't in the message are refused", async () => {
    const message = theirs("The tide turns.");
    const wrong = await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "the moon rises", replacement: "x" });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toContain("aren't in the message");
    expect((await call("POST", `/api/messages/${message.id}/rewrites`, { quote: "tide turns", replacement: "tide comes in" })).status).toBe(200);
  });

  test("the highlighted words are found even with formatting in between", () => {
    expect(applyRewrite("*Ilse* waits by the *door*.", "Ilse waits", "Ilse lingers")).toBe("Ilse lingers by the *door*.");
    expect(applyRewrite("Gone.", "not here", "x")).toBeNull();
  });
});

describe("the tool map", () => {
  test("one line per tool, in their words; an empty line removes it; only real tools", async () => {
    expect((await runTool(ctx(), "write_map_entry", { tool: "check", when: "I'd reach for this when I'm not sure a detail is true." })).ok).toBe(true);
    expect(toolMap(app.store).check!.when).toBe("I'd reach for this when I'm not sure a detail is true.");
    expect((await runTool(ctx(), "write_map_entry", { tool: "fly", when: "never" })).ok).toBe(false);
    // Their line sits beside the tool, where they decide.
    const spec = toolSpecs(ctx()).find((t) => t.function.name === "check")!;
    expect(spec.function.description).toContain(`Your own note on it: "I'd reach for this when I'm not sure a detail is true."`);
    await runTool(ctx(), "write_map_entry", { tool: "check", when: "" });
    expect(toolMap(app.store).check).toBeUndefined();
  });
});

describe("#channel tags", () => {
  test("a #tag in #practice brings the channel in; with no summary yet, its newest posts", () => {
    theirs("*The ferry horn sounds twice.*");
    const practice = app.store.ensurePractice();
    app.store.addTurn([{ channelId: practice.id, author: "user", content: `Could you end the scene in #${story.name}?` }]);
    const prompt = promptForChannel(app.store, practice.id, { profile: pickProfile(app.store, practice) })[0]!.content;
    expect(prompt).toContain(`## About #${story.name}`);
    expect(prompt).toContain("No summary yet. Its newest posts:");
    expect(prompt).toContain("The ferry horn sounds twice.");
  });
});

describe("what a channel is for", () => {
  const prompt = (channel: Channel) => promptForChannel(app.store, channel.id, { profile: pickProfile(app.store, channel) })[0]!.content;

  test("one line, in its prompt and beside its name in the others; too long is refused", async () => {
    const offTopic = app.store.createChannel({ name: "off-topic", kind: "ooc" });
    const { status } = await call("PATCH", `/api/channels/${offTopic.id}`, { about: "  anything but the stories:\n music, food, our days " });
    expect(status).toBe(200);
    expect(app.store.getChannel(offTopic.id).about).toBe("anything but the stories: music, food, our days");
    expect(prompt(app.store.getChannel(offTopic.id))).toContain("What this channel is for: anything but the stories: music, food, our days");
    const ooc = app.store.listChannels().find((c) => c.name === "ooc")!;
    expect(prompt(ooc)).toContain("- #off-topic: another out-of-character chat (for: anything but the stories: music, food, our days)");
    expect((await call("PATCH", `/api/channels/${offTopic.id}`, { about: "x".repeat(301) })).status).toBe(400);
  });

  test("they can say it too, visibly", async () => {
    const outcome = await runTool(ctx(), "describe_channel", { channel: "#story", about: "the lighthouse storyline" });
    expect(outcome.ok).toBe(true);
    expect(app.store.getChannel(story.id).about).toBe("the lighthouse storyline");
    // What the tool log and your feed show.
    expect(outcome.summary).toContain("#story is for: the lighthouse storyline");
  });

  test("another OOC chat comes in only when #tagged; a storyline by its bare name too", () => {
    const offTopic = app.store.createChannel({ name: "off-topic", kind: "ooc" });
    const said = (content: string) => app.store.addTurn([{ channelId: offTopic.id, author: "user", content }]);
    said("we said this in ooc earlier, and the story was fun");
    const channels = app.store.listChannels();
    const names = () => mentionCandidates(offTopic, channels, app.store.getMessages(offTopic.id)).map((c) => c.channel.name);
    expect(names()).toEqual(["story"]);
    said("see #ooc");
    expect(names()).toEqual(["story", "ooc"]);
  });
});

