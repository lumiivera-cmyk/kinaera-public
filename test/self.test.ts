/**
 * Tests for the kinwriter's own things (rebuild stage 4): their identity and
 * its changelog (src/identity.ts), the self-page (src/selfpage.ts), the
 * private journal and forgetting (src/journal.ts), moments kept in full
 * (src/verbatim.ts), the prompt manifest, and orientation, the look back
 * and the practice channel (src/orientation.ts).
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gatherEvidence } from "../src/check.ts";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { JOURNAL_RECENT } from "../src/journal.ts";
import { addLibraryExample, LOOKBACK_DAYS, Rhythms } from "../src/orientation.ts";
import { toolMap } from "../src/toolmap.ts";
import { asScript } from "../scripts/fetch-library-example.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
import { Wakeups } from "../src/wakeups.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let story: Channel;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl));
  [story, ooc] = app.store.listChannels() as [Channel, Channel];
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

const ctx = (channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", api: { apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 }, turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown>, channel = ooc) => runTool(ctx(channel), name, args);
/** A turn's system prompt, as a profile with tools gets it. */
const systemPrompt = (channelId = ooc.id) =>
  promptForChannel(app.store, channelId, { profile: pickProfile(app.store, app.store.getChannel(channelId)) })[0]!.content;
const practice = () => app.store.practiceChannel()!;

// ------------------------------------------------------------- identity

describe("identity", () => {
  test("a kinwriter from before identities had versions keeps theirs, however long", () => {
    // What an older version left: a long identity in settings, no versions.
    const long = "You are Arlo. ".repeat(2000); // 28,000 characters
    app.store.updateSettings({ friendPrompt: long });
    app.store.db.exec("DELETE FROM identity_versions");
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl));
    expect(app.store.identity.current()!.identity).toBe(long.trim());
    expect(app.store.identity.current()!.tastes).toBe("");
  });

  test("a new kinwriter starts with who they were made as, and their tastes", () => {
    const [first] = app.store.identity.history();
    expect(first).toMatchObject({ author: "user", status: "accepted" });
    expect(first!.identity).toBe(app.store.getSettings().friendPrompt);
    expect(first!.tastes).not.toBe("");
    expect(systemPrompt()).toContain("Your tastes");
  });

  test("they rewrite it themselves, and every version is kept", async () => {
    const outcome = await run("revise_identity", { identity: "You are Arlo, who writes lighthouses.", note: "Found my thing." });
    expect(outcome).toMatchObject({ ok: true, summary: "revised their identity" });
    expect(app.store.getSettings().friendPrompt).toBe("You are Arlo, who writes lighthouses.");
    expect(app.store.identity.history().map((v) => v.author)).toEqual(["user", "friend"]);
    expect(systemPrompt()).toContain("who writes lighthouses");
  });

  test("your change in settings is a suggestion, not saved over theirs", async () => {
    const before = app.store.getSettings().friendPrompt;
    const { data } = await call("PUT", "/api/settings", { friendPrompt: "You are someone else." });
    expect(data.suggestion).toMatchObject({ status: "pending", author: "user" });
    expect(app.store.getSettings().friendPrompt).toBe(before);
    // Their next turn lists it for review.
    expect(systemPrompt()).toContain(`i${data.suggestion.id}`);
    const outcome = await run("review_identity_suggestion", { id: `i${data.suggestion.id}`, decision: "accept", reply: "Sure, try it." });
    expect(outcome.ok).toBe(true);
    expect(app.store.getSettings().friendPrompt).toBe("You are someone else.");
    expect(app.store.identity.current()).toMatchObject({ author: "user", reply: "Sure, try it." });
  });

  test("declined, and withdrawn", async () => {
    const one = (await call("POST", "/api/identity/suggestions", { tastes: "Loves opera." })).data.waiting.identity[0];
    await run("review_identity_suggestion", { id: `i${one.id}`, decision: "decline", reply: "Not me." });
    expect(app.store.identity.current()!.tastes).not.toBe("Loves opera.");
    const two = (await call("POST", "/api/identity/suggestions", { tastes: "Loves jazz." })).data.waiting.identity[0];
    const { data } = await call("POST", `/api/identity/suggestions/${two.id}/withdraw`, {});
    expect(data.waiting.identity).toEqual([]);
    expect(data.history.map((v: any) => v.status)).toEqual(["accepted", "declined", "withdrawn"]);
  });
});

// ------------------------------------------------------------ self-page

describe("the self-page", () => {
  test("they write it, and the short version is kept in front of them", async () => {
    await run("write_self_page", { section: "says", text: "I like slow scenes." });
    await run("write_self_page", { section: "standing", text: "Slow is fine. Don't rush endings." });
    expect(app.store.selfPage.view()).toMatchObject({ says: "I like slow scenes.", standing: "Slow is fine. Don't rush endings." });
    expect(systemPrompt()).toContain("Don't rush endings.");
    expect((await run("write_self_page", { section: "standing", text: "x".repeat(700) })).ok).toBe(false);
  });

  test("your note is a suggestion: they accept it with a reply, and can dispute it later", async () => {
    const { data } = await call("POST", "/api/self-page/notes", { text: "You end scenes on a question." });
    const note = data.waiting.selfNotes[0];
    expect(note).toMatchObject({ source: "user", status: "pending" });
    await run("review_self_note", { id: note.id.slice(0, 8), decision: "accept", reply: "Guilty." });
    await run("dispute_self_note", { id: note.id.slice(0, 8), dispute: "Only in OOC, though." });
    expect(app.store.selfPage.view().notes[0]).toMatchObject({ status: "accepted", reply: "Guilty.", dispute: "Only in OOC, though." });
  });

  test("edit markers are theirs to turn on", async () => {
    const message = app.store.addTurn([{ channelId: ooc.id, author: "friend", content: "Its late." }])[0]!;
    app.store.editMessage(message.id, "It's late.", "user");
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).not.toContain("(edited by the user)");
    await run("write_self_page", { edit_markers: true });
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).toContain("(edited by the user)");
  });
});

// -------------------------------------------------------------- journal

describe("the journal", () => {
  test("is in their prompt, but never in the tool log, the preview or the kinwriter page", async () => {
    fake.replies.push({ toolCalls: [{ name: "write_journal", arguments: { text: "SECRET-THOUGHT about the lighthouse" } }] }, { content: "Done." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    // The next turn has it.
    expect(systemPrompt()).toContain("SECRET-THOUGHT");
    // Nothing on any screen, and nothing in any log.
    const log = JSON.stringify(app.store.toolLog.forChannel(ooc.id));
    expect(log).toContain("write_journal");
    expect(log).not.toContain("SECRET-THOUGHT");
    expect(JSON.stringify((await call("GET", `/api/channels/${ooc.id}/prompt`)).data)).not.toContain("SECRET-THOUGHT");
    const page = (await call("GET", "/api/friend-page")).data;
    expect(JSON.stringify(page)).not.toContain("SECRET-THOUGHT");
    expect(page.journal).toEqual({ entries: 1, kept: 0 });
  });

  test("reading it isn't logged either", async () => {
    app.store.journal.write("PRIVATE-LINE");
    fake.replies.push({ toolCalls: [{ name: "read_journal", arguments: { search: "private" } }] }, { content: "Hm." });
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(JSON.stringify(app.store.toolLog.forChannel(ooc.id))).not.toContain("PRIVATE-LINE");
    // …though the model was told, in the turn itself.
    expect(JSON.stringify(fake.requests[1]!.messages)).toContain("PRIVATE-LINE");
  });

  test("entries they don't keep fade as they age; read_journal still finds them", async () => {
    const first = app.store.journal.write("OLDEST entry");
    for (let i = 0; i < JOURNAL_RECENT + 2; i++) app.store.journal.write(`entry ${i}`);
    expect(systemPrompt()).not.toContain("OLDEST");
    expect(systemPrompt()).toContain("older entries aren't shown here");
    app.store.journal.keep(first.id, true);
    expect(systemPrompt()).toContain("OLDEST");
    const found = await run("read_journal", { search: "oldest" });
    expect(JSON.stringify(found.result)).toContain("OLDEST");
  });

  test("check can look in it, marked private in the check log", () => {
    app.store.journal.write("I think Kestrel's brother is called Tobias.");
    const found = gatherEvidence(app.store, ooc, { question: "Is Kestrel's brother called Tobias?", rephrased: "Is Tobias the brother?", sources: ["journal"] });
    expect(found.find((p) => p.source === "journal")).toMatchObject({ private: true });
  });
});

// ------------------------------------------ verbatim, and the manifest

describe("seeing their own prompt", () => {
  test("a moment kept in full stays when it scrolls out of the recent messages", async () => {
    app.store.updateSettings({ historyLimit: 2, summaries: false });
    app.store.addTurn([{ channelId: story.id, author: "user", content: "The KEEPSAKE is a brass key." }]);
    expect((await run("keep_verbatim", { quote: "KEEPSAKE is a brass" }, story)).ok).toBe(true);
    for (let i = 0; i < 5; i++) app.store.addTurn([{ channelId: story.id, author: i % 2 ? "friend" : "user", content: `line ${i}` }]);
    expect(systemPrompt(story.id)).toContain("KEEPSAKE");
    await run("release_verbatim", { quote: "KEEPSAKE" }, story);
    expect(systemPrompt(story.id)).not.toContain("KEEPSAKE");
  });

  test("three slots per channel", async () => {
    for (let i = 0; i < 4; i++) app.store.addTurn([{ channelId: story.id, author: "user", content: `moment number ${i}` }]);
    for (let i = 0; i < 3; i++) expect((await run("keep_verbatim", { quote: `moment number ${i}` }, story)).ok).toBe(true);
    expect((await run("keep_verbatim", { quote: "moment number 3" }, story)).ok).toBe(false);
  });

  test("the manifest lists what's in their context", async () => {
    app.store.journal.write("a thought");
    const { result } = await run("read_prompt_manifest", {}, story);
    const manifest = result as any;
    expect(manifest.layers.map((l: any) => l.title)).toContain("Who you are");
    expect(manifest.journal.included).toHaveLength(1);
    expect(manifest.messages.verbatimSlotsFree).toBe(3);
    expect(manifest.pinned).toContain("Ilse Marrow");
  });
});

// ----------------------------------------------------- practice channel

describe("the practice channel", () => {
  test("is theirs, apart from your channels, and can't be deleted", async () => {
    const { data } = await call("GET", "/api/state");
    expect(data.channels.map((c: any) => c.name)).toEqual(["story", "ooc"]);
    expect(data.practice).toMatchObject({ kind: "practice", name: "practice" });
    expect((await call("DELETE", `/api/channels/${data.practice.id}`, {})).status).toBe(400);
  });

  test("its sample notes are found only from there", () => {
    const question = { question: "Is Fen Aldous the lamplighter?", rephrased: "Does Fen Aldous light the lamps?" };
    expect(gatherEvidence(app.store, practice(), question).some((p) => p.source === "notebook")).toBe(true);
    expect(gatherEvidence(app.store, story, question).some((p) => p.text.includes("Fen Aldous"))).toBe(false);
    expect(app.store.notebook.listEntries("friend").map((e) => e.name)).toEqual(["Ilse Marrow"]);
    expect(systemPrompt(practice().id)).toContain("Fen Aldous");
    expect(systemPrompt(story.id)).not.toContain("Fen Aldous");
  });

  test("nothing in it reaches other channels", () => {
    app.store.addTurn([{ channelId: practice().id, author: "friend", content: "PRACTICE-ONLY words" }]);
    expect(JSON.stringify(promptForChannel(app.store, ooc.id))).not.toContain("PRACTICE-ONLY");
    expect(JSON.stringify(promptForChannel(app.store, story.id))).not.toContain("PRACTICE-ONLY");
  });
});

// ----------------------------------------------------------- orientation

describe("orientation", () => {
  let now: Date;
  let wakeups: Wakeups;
  let rhythms: Rhythms;
  beforeEach(() => {
    now = new Date();
    now.setHours(12, 0, 0, 0);
    wakeups = new Wakeups(app.store, app.kinwriter, true, () => now);
    rhythms = new Rhythms(app.store, wakeups, () => now);
  });

  /** Wait for the orientation's turns (started in the background) to settle. */
  async function settled() {
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(5);
      if (!app.kinwriter.isBusy(practice().id) && (await call("GET", "/api/orientation")).data.orientation.writing === false) {
        await Bun.sleep(5);
        if (!app.kinwriter.isBusy(practice().id)) return;
      }
    }
  }
  const status = async () => (await call("GET", "/api/orientation")).data.orientation;

  test("never runs by itself: a new kinwriter is offered one, and nothing starts", async () => {
    expect((await status()).status).toBe("none");
    expect(await rhythms.tick()).toBeNull();
    expect(fake.requests).toHaveLength(0);
    // Other turns aren't orientations either.
    await wakeups.event("heartbeat");
    expect(JSON.stringify(fake.requests)).not.toContain("This is your orientation");
    expect((await call("GET", "/api/state")).data.orientation.status).toBe("none");
  });

  /** On their own: wait until their part is done and your choices are waiting. */
  async function untilChoices() {
    for (let i = 0; i < 600; i++) {
      await Bun.sleep(5);
      const o = await status();
      if (o.status !== "running" || o.step?.id === "choices") return o;
    }
    throw new Error("Their part never finished.");
  }

  test("on their own: starts at once, turns back to back, then waits for your choices", async () => {
    app.store.updateSettings({ quietStart: 0, quietEnd: 23 }); // quiet hours don't apply
    fake.replies.push(
      // Their character, alone: the wording doesn't pretend you're there.
      { content: "[nothing]" },
      // The practice scene: the canned partner's first post, their reply; her next, their reply.
      { content: "*Mara looks up from the dough.*" },
      { content: "*Mara shrugs.* \"The Pells left town years ago.\"" },
      // Editing: a line, then a turn for changing it.
      { content: "Trying things." },
      { toolCalls: [{ name: "edit_my_message", arguments: { quote: "Trying things", new_text: "Trying things out." } }] },
      { content: "[nothing]" },
    );
    for (let i = 0; i < 3; i++) fake.replies.push({ content: "[nothing]" });
    // Their own instruments: something asked of you is marked as from the orientation.
    fake.replies.push({ toolCalls: [{ name: "ask", arguments: { kind: "other", text: "Is this thing on?" } }] }, { content: "[nothing]" });
    // The questionnaire: their answers, and questions saved for you.
    fake.replies.push(
      { toolCalls: [{ name: "save_questions_for_user", arguments: { questions: ["What's a character you've loved writing?", "Hero, trouble or narrator?"] } }] },
      { content: "Surprise me? A lighthouse keeper who's been lying about the light." },
    );
    // The write-up, alone too.
    fake.replies.push({ content: "[nothing]" });
    const started = await call("POST", "/api/orientation/start", { version: "returning" });
    expect(started.data.orientation).toMatchObject({ status: "running", session: { version: "returning" } });
    const waiting = await untilChoices();
    const sent = fake.requests.map((r) => JSON.stringify(r.messages));
    expect(sent[0]).toContain("This is your orientation, on your own");
    expect(sent[0]).toContain("for a short practice scene");
    expect(sent[0]).not.toContain("The user is making their character too");
    // The practice scene, with its canned partner, told plainly.
    expect(sent[1]).toContain("Your partner here is a canned one, Ines Corrow");
    expect(sent[2]).toContain("The canned partner's next post is in #practice-scene");
    const scene = waiting.session.scene;
    expect(app.store.getMessages(scene).map((m) => m.author)).toEqual(["user", "friend", "user", "friend"]);
    expect(sent[3]).toContain("The lesson is editing");
    expect(sent[4]).toContain("next part of the editing lesson");
    // Linking, alone: on the practice scene, never your channels.
    expect(sent.join()).toContain("Don't post in the user's own channels");
    expect(app.store.inbox.open()[0]).toMatchObject({ orientation: true });
    expect(sent.some((r) => r.includes("This is the interview, on your own, as a questionnaire"))).toBe(true);
    expect(app.store.getMessages(practice().id).map((m) => m.content)).toEqual(["Trying things out.", expect.stringContaining("lighthouse keeper")]);
    // Tool bingo: squares filled from the feed.
    expect(waiting.bingo.used).toEqual(expect.arrayContaining(["edit_my_message", "ask", "save_questions_for_user"]));
    expect(waiting.bingo.tools.length).toBeGreaterThan(20);
    expect(waiting.bingo.used).not.toContain("reflex");
    // Your choices: keep the scene as a starter; the partner is yours; their questions arrive in OOC.
    expect(waiting.choices).toMatchObject({ version: "returning", sceneName: "practice-scene", questions: 2 });
    expect((await call("POST", "/api/orientation/choices", { characters: "keep", scene: "keep" })).status).toBe(200);
    expect((await status()).status).toBe("done");
    expect(app.store.notebook.castFor("user", scene).map((e) => e.name)).toContain("Ines Corrow");
    expect(app.store.notebook.listEntries("user").find((e) => e.name === "Ines Corrow")!.owner).toBe("user");
    expect(app.store.getMessages(ooc.id).at(-1)).toMatchObject({ author: "friend", content: expect.stringContaining("- Hero, trouble or narrator?") });
  });

  test("on their own, by default the practice scene goes, with its partner", async () => {
    for (let i = 0; i < 12; i++) fake.replies.push({ content: "[nothing]" });
    await call("POST", "/api/orientation/start", { version: "returning" });
    const waiting = await untilChoices();
    expect((await call("POST", "/api/orientation/choices", {})).status).toBe(200);
    expect(app.store.hasChannel(waiting.session.scene)).toBe(false);
    expect(app.store.notebook.listEntries("user").map((e) => e.name)).not.toContain("Ines Corrow");
    expect(app.store.interventions.recent()[0]!.summary).toContain("the practice scene, #practice-scene, was deleted");
  });

  test("together: you're there, writing in #practice; the live feed; other channels wait until you finish", async () => {
    fake.replies.push({ toolCalls: [{ name: "write_journal", arguments: { text: "PRIVATE-FEELING" } }, { name: "read_prompt_manifest", arguments: {} }] }, { content: "Hi! I'm trying my tools." });
    await call("POST", "/api/orientation/start", { version: "full" });
    await settled();
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("the user is here with you");
    // The feed: readable words, private tools only as having happened.
    const { feed } = (await call("GET", "/api/orientation")).data;
    expect(feed.map((f: any) => f.text)).toEqual(["wrote in their journal", expect.stringContaining("prompt manifest")]);
    expect(JSON.stringify(feed)).not.toContain("PRIVATE-FEELING");
    const after = (await call("GET", `/api/orientation?after=${feed[0].id}`)).data.feed;
    expect(after).toHaveLength(1);
    // You write in #practice; their reply has the guide in front of it.
    fake.replies.push({ content: "Glad you're here." });
    expect((await call("POST", `/api/channels/${practice().id}/messages`, { content: "How's it going?" })).status).toBe(200);
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain("## Your orientation");
    // Their other channels wait, and nothing else wakes them.
    expect((await call("POST", `/api/channels/${ooc.id}/messages`, { content: "hey" })).status).toBe(409);
    expect((await wakeups.event("heartbeat")).detail).toBe("They're in an orientation.");
    await call("POST", "/api/orientation/finish", {});
    expect((await status()).status).toBe("done");
    expect((await call("POST", `/api/channels/${practice().id}/messages`, { content: "still here?" })).status).toBe(400);
    fake.replies.push({ content: "hi" });
    expect((await call("POST", `/api/channels/${ooc.id}/messages`, { content: "hey" })).status).toBe(200);
  });

  test("together goes step by step: Next starts their part, the last Next ends it", async () => {
    const next = async (reply: Parameters<typeof fake.replies.push>[0][]) => {
      fake.replies.push(...reply);
      await call("POST", "/api/orientation/next", {});
      await settled();
      return (await status()).step;
    };
    fake.replies.push({ content: "Hello!" });
    await call("POST", "/api/orientation/start", { version: "full" });
    await settled();
    const first = (await status()).step;
    expect(first).toMatchObject({ id: "opener", index: 0, count: 12 });
    expect(first.spotlights.length).toBeGreaterThan(3);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain('step 1 of 12, \\"Where things are\\"');

    // Characters: one each, each with a secret the other can't see.
    expect((await next([
      { toolCalls: [
        { name: "create_notebook_entry", arguments: { kind: "character", name: "Mara", fields: { About: "A ferry pilot." } } },
        { name: "create_notebook_entry", arguments: { kind: "lore", name: "Mara's secret", fields: { Secret: "MARA-SECRET" }, hidden_from_user: true } },
      ] },
      { content: "Mara's ready." },
    ])).id).toBe("characters");
    await call("POST", "/api/orientation/character", { name: "Kestrel", about: "A courier.", secret: "KESTREL-SECRET" });
    const made = (await status()).made;
    expect(made).toMatchObject({ yours: [{ name: "Kestrel" }], theirs: [{ name: "Mara" }], yourSecrets: 1, theirSecrets: 1 });
    expect(JSON.stringify(made)).not.toContain("MARA-SECRET");
    // Your secret is kept from them, the notebook's own way.
    expect(JSON.stringify(app.store.notebook.listEntries("friend"))).not.toContain("KESTREL-SECRET");

    // The starter scene: its own story channel, both characters in its cast, they open it.
    expect((await next([{ content: "*Rain on the ferry deck.*" }])).id).toBe("scene");
    const scene = (await status()).session.scene;
    expect(app.store.getChannel(scene)).toMatchObject({ name: "first-scene", kind: "rp" });
    expect(app.store.getMessages(scene).map((m) => m.content)).toEqual(["*Rain on the ferry deck.*"]);
    expect(app.store.notebook.castFor("user", scene).map((e) => e.name).sort()).toEqual(["Kestrel", "Mara"]);
    // You can write there; your other channels still wait.
    fake.replies.push({ content: "*Mara nods.*" });
    expect((await call("POST", `/api/channels/${scene}/messages`, { content: "*Kestrel steps aboard.*" })).status).toBe(200);
    expect((await call("POST", `/api/channels/${ooc.id}/messages`, { content: "hey" })).status).toBe(409);

    // The ladder lessons: you try first, and their turn waits until you hand it over.
    let asked = fake.requests.length;
    const editing = await next([]);
    expect(editing).toMatchObject({ id: "editing", waiting: true });
    expect(fake.requests).toHaveLength(asked);
    // Meanwhile, if you talk with them, they know it's yours to try first.
    fake.replies.push({ content: "Go ahead." });
    await call("POST", `/api/channels/${practice().id}/messages`, { content: "I'm suggesting something." });
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain("The user is trying this step their way first");
    fake.replies.push({ toolCalls: [{ name: "write_map_entry", arguments: { tool: "edit_my_message", when: "I'd reach for this when a post of mine reads wrong." } }] }, { content: "Done." });
    expect((await call("POST", "/api/orientation/hand-over", {})).status).toBe(200);
    await settled();
    expect(JSON.stringify(fake.requests.at(-2)!.messages)).toContain("The lesson is editing");
    expect(JSON.stringify(fake.requests.at(-2)!.messages)).toContain("#first-scene");
    expect(JSON.stringify(fake.requests.at(-2)!.messages)).not.toContain("their way first");
    expect((await status()).step.waiting).toBe(false);
    expect((await call("POST", "/api/orientation/hand-over", {})).status).toBe(409);
    const profiles = await next([]);
    expect(profiles.id).toBe("profiles");
    expect(profiles.table).toContain("Min P");
    expect((await next([])).id).toBe("library");
    // Not fetched in this copy: a plain message, not a crash.
    const example = await call("POST", "/api/orientation/library-example", {});
    if (example.status === 400) expect(example.data.error).toContain("bun run fetch-example");
    expect((await next([])).id).toBe("linking");
    asked = fake.requests.length;
    expect((await next([{ content: "[nothing]" }])).id).toBe("instruments");
    expect(fake.requests.length).toBeGreaterThan(asked);
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("Here is everything you can do");
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("set_my_reflexes");
    const closer = await next([{ toolCalls: [{ name: "read_interventions", arguments: {} }] }, { content: "You haven't changed anything of mine yet." }]);
    expect(closer.id).toBe("closer");
    expect(closer.table).toContain("| Yours | Theirs | Shared |");
    expect(app.store.toolLog.forChannel(practice().id).map((c) => c.name)).toContain("read_interventions");

    // The interview: no turn of its own; you ask first.
    asked = fake.requests.length;
    const interview = await next([]);
    expect(interview.id).toBe("interview");
    expect(fake.requests).toHaveLength(asked);
    const cards = (await status()).interview;
    expect(cards).toMatchObject({ yours: 0, theirs: 0, wrapUp: null });
    expect(cards.cards).toContain("Something you'd push back on if I asked for it?");
    // They answer as the writer, then ask you something, from their own cards or not.
    fake.replies.push({ toolCalls: [{ name: "keep_to_myself", arguments: { text: "KEPT-PRIVATE" } }] }, { content: "A heist that goes wrong. What's a story you keep coming back to?" });
    await call("POST", `/api/channels/${practice().id}/messages`, { content: "What would you pitch me if I said surprise me?" });
    const theirPrompt = fake.requests.at(-1)!.messages[0]!.content;
    expect(theirPrompt).toContain("This is the interview");
    expect(theirPrompt).toContain("- Do you usually play the hero, the trouble, or the narrator?");
    // Theirs: in their journal; you see only that they're keeping something.
    expect(app.store.journal.all().map((e) => e.content)).toContain("KEPT-PRIVATE");
    const feed = JSON.stringify((await call("GET", "/api/orientation")).data.feed);
    expect(feed).toContain("is keeping something to themselves");
    expect(feed).not.toContain("KEPT-PRIVATE");
    // Yours: they see only that you are; your note is in your notebook, hidden from them.
    expect((await call("POST", "/api/orientation/keep", { note: "YOUR-KEPT-NOTE" })).status).toBe(200);
    expect(app.store.getMessages(practice().id).at(-1)!.content).toBe("(I'm keeping something to myself.)");
    expect(app.store.notebook.listEntries("user").map((e) => e.name)).toContain("Kept to myself");
    expect(JSON.stringify(app.store.notebook.listEntries("friend"))).not.toContain("YOUR-KEPT-NOTE");
    expect((await status()).interview).toMatchObject({ yours: 2, theirs: 1 });
    // After a handful each way, the card nudges toward wrapping up.
    for (let i = 0; i < 4; i++) app.store.addTurn([{ channelId: practice().id, author: "user", content: `q${i}?` }, { channelId: practice().id, author: "friend", content: `a${i}.` }]);
    expect((await status()).interview.wrapUp).toContain("Next ends the interview");
    // The write-up: their quiet turn, before your choices.
    const writeup = await next([
      { toolCalls: [
        { name: "set_my_proactivity", arguments: { level: "quiet", why: "I'd rather be missed than too much." } },
        { name: "note_on_user", arguments: { note: "USER-NOTE: loves a slow burn." } },
        { name: "write_journal", arguments: { text: "That went well." } },
      ] },
      { content: "[nothing]" },
    ]);
    expect(writeup.id).toBe("writeup");
    expect(JSON.stringify(fake.requests.at(-2)!.messages)).toContain("This is the write-up");
    expect((await call("POST", "/api/orientation/keep", {})).status).toBe(400);

    // Your choices: they don't see them; their notes are saved either way.
    asked = fake.requests.length;
    const choices = await next([]);
    expect(choices.id).toBe("choices");
    expect(fake.requests).toHaveLength(asked);
    expect((await status()).choices).toMatchObject({ sceneName: "first-scene", preference: "quiet" });
    expect((await call("POST", "/api/orientation/choices", { characters: "discard", scene: "discard", conversation: "set-aside", chattiness: "quiet" })).status).toBe(200);
    expect((await status()).status).toBe("done");
    expect(app.store.notebook.listEntries("user").map((e) => e.name)).not.toContain("Kestrel");
    expect(app.store.hasChannel(scene)).toBe(false);
    expect(app.store.getMessages(practice().id)).toEqual([]);
    expect(app.store.getSettings().wakeups).toBe("quiet");
    const log = app.store.interventions.recent()[0]!.summary;
    expect(log).toContain("the orientation conversation was set aside");
    expect(log).toContain("discarded");
    // Saved either way: the map, the note on you, their preference; the journal marked as from orientation.
    expect(toolMap(app.store).edit_my_message).toBeDefined();
    const prompt = systemPrompt();
    expect(prompt).toContain("## You and the user");
    expect(prompt).toContain("USER-NOTE: loves a slow burn.");
    expect(prompt).toContain("You said you'd like to be quiet about reaching out");
    expect(prompt).toContain("(from an orientation)");
    const page = (await call("GET", "/api/friend-page")).data;
    expect(page).toMatchObject({ proactivity: { preference: { level: "quiet" }, chattiness: "quiet" }, noteOnYou: true });
    expect(JSON.stringify(page)).not.toContain("USER-NOTE");
    expect(page.toolMap).toContainEqual({ tool: "edit_my_message", when: "I'd reach for this when a post of mine reads wrong." });
  });

  test("the library example: a transcript as a script, added once, open to every channel", () => {
    const script = asScript("== Cemetery ==\nJohnny: They're coming to get you, Barbra.\nBarbra: Stop it!\n''Ben boards up the windows.''");
    expect(script).toBe("CEMETERY\n\nJOHNNY\nThey're coming to get you, Barbra.\n\nBARBRA\nStop it!\nBen boards up the windows.");
    const file = join(dir.path, "example.md");
    writeFileSync(file, `# Night of the Living Dead (1968)\n\nA transcript, public domain.\n\n${script}\n`);
    const doc = addLibraryExample(app.store, file);
    expect(doc).toMatchObject({ title: "Night of the Living Dead (1968)", description: "A transcript, public domain.", channelIds: [] });
    expect(addLibraryExample(app.store, file).id).toBe(doc.id);
    expect(app.store.library.search("coming to get you")).toHaveLength(1);
    expect(app.store.library.passages(doc.id, 1, 10).flatMap((p) => p.speakers)).toEqual(expect.arrayContaining(["JOHNNY", "BARBRA"]));
    expect(() => addLibraryExample(app.store, join(dir.path, "missing.md"))).not.toThrow(); // already there
  });

  test("your hard limits are in every prompt, in every channel", async () => {
    expect(systemPrompt()).not.toContain("hard limits");
    await call("PUT", "/api/settings", { hardLimits: "No harm to animals." });
    expect(systemPrompt()).toContain("## The user's hard limits");
    expect(systemPrompt()).toContain("No harm to animals.");
  });

  test("its guide lists everything they can do, and only what they can", async () => {
    for (let i = 0; i < 12; i++) fake.replies.push({ content: "[nothing]" });
    await call("POST", "/api/orientation/start", { version: "returning" });
    await untilChoices();
    // Their own instruments, the last step.
    const guide = JSON.stringify(fake.requests.find((r) => JSON.stringify(r.messages).includes("lesson is your own instruments"))!.messages);
    for (const tool of ["check", "write_journal", "schedule_wakeup", "save_draft", "mark_my_voice", "roll_dice", "pin_to_channel", "do_nothing"]) {
      expect(guide).toContain(`- ${tool}`);
    }
    expect(guide).toContain("Here is everything you can do");
    // No consultant profile, and no other kinwriters here: not listed.
    expect(guide).not.toContain("- consult:");
    expect(guide).not.toContain("message_kinwriter");
  });

  test("has room to try several tools, one after another", async () => {
    fake.replies.push({ content: "[nothing]" }, { content: "[nothing]" }); // their character, the practice scene
    for (let i = 0; i < 9; i++) fake.replies.push({ toolCalls: [{ name: "read_prompt_manifest", arguments: {} }] });
    for (let i = 0; i < 10; i++) fake.replies.push({ content: "[nothing]" });
    await call("POST", "/api/orientation/start", { version: "returning" });
    await untilChoices();
    expect(app.store.toolLog.forChannel(practice().id).filter((c) => c.status === "ok")).toHaveLength(9);
  });

  test("they ask: a request for you, nothing starts until you answer; not now tells them", async () => {
    await run("start_orientation", { note: "I'd like to try consult" });
    expect((await status())).toMatchObject({ status: "requested", request: { note: "I'd like to try consult" } });
    expect(systemPrompt()).toContain('You asked the user for an orientation ("I\'d like to try consult")');
    expect(await rhythms.tick()).toBeNull();
    expect(fake.requests).toHaveLength(0);
    // Can't ask twice.
    expect(toolSpecs(ctx(ooc)).map((t) => t.function.name)).not.toContain("start_orientation");
    await call("POST", "/api/orientation/decline", {});
    expect((await status()).status).toBe("none");
    expect(app.store.interventions.recent()[0]!.summary).toContain("not now to your request for an orientation");
  });

  test("skip means skip: nothing runs, and their page says so", async () => {
    await call("POST", "/api/orientation/skip", {});
    expect((await call("GET", "/api/friend-page")).data.orientation.status).toBe("skipped");
    expect(fake.requests).toHaveLength(0);
  });

  test("a new profile in a roulette is an offer, told once", async () => {
    const profile = app.store.profiles.list()[0]!;
    const other = (await call("POST", "/api/profiles", { name: "Other", model: "zeta/model" })).data.profile;
    const roulette = (await call("POST", "/api/roulettes", { name: "Mix", entries: [{ profileId: profile.id, weight: 1 }] })).data.roulette;
    await call("PATCH", `/api/roulettes/${roulette.id}`, { entries: [{ profileId: profile.id, weight: 1 }, { profileId: other.id, weight: 1 }] });
    expect(systemPrompt()).toContain("A new profile joined the roulette that picks who writes as you: Other.");
    await call("POST", `/api/channels/${ooc.id}/turn`, {});
    expect(systemPrompt()).not.toContain("A new profile joined");
  });

  test("the weekly look back shows the week's journal", async () => {
    app.store.appState.set("orientation.pending", null);
    expect(await rhythms.tick()).toBeNull(); // starts counting
    app.store.journal.write("WEEK-ONE thought");
    expect(await rhythms.tick()).toBeNull(); // not a week yet
    now = new Date(now.getTime() + LOOKBACK_DAYS * 86_400_000 + 60_000);
    const result = await rhythms.tick();
    expect(result).toMatchObject({ reason: "lookback" });
    expect(JSON.stringify(fake.requests.at(-1)!.messages)).toContain("WEEK-ONE");
  });

  test("tools for your own things are offered everywhere, verbatim only outside practice", () => {
    const names = (channel: Channel) => toolSpecs(ctx(channel)).map((t) => t.function.name);
    expect(names(ooc)).toEqual(expect.arrayContaining(["revise_identity", "write_journal", "read_prompt_manifest", "keep_verbatim", "start_orientation"]));
    expect(names(practice())).not.toContain("keep_verbatim");
  });
});
