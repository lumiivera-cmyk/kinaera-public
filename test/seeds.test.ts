/**
 * Kinwriter generation, step 1 (design/kinwriter-generation/spec.md, "Build order"):
 * the seed format, Accept, self-notes (private unless shared), the
 * orientation handoff, and a new name on request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp, type App } from "../src/server.ts";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { orientationGuide, orientationSteps } from "../src/orientation.ts";
import { runTool, type ToolContext } from "../src/tools.ts";
import { SETUP_PENDING, Store } from "../src/store.ts";
import { checkHeadings, containsTerm, parseSeed, seedWordCount, validateSeed, writeSeed, type Seed } from "../src/seeds.ts";
import { selfShared, SHARED_NOTICE } from "../src/selfnotes.ts";
import { stillSeedDraft } from "../src/handoff.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

const MARGO = readFileSync(join(import.meta.dir, "..", "kinwriter-generator", "test-seed.md"), "utf8");

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl, { developerPanel: true }));
  ooc = app.store.listChannels().find((c) => c.kind === "ooc")!;
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

const ctx = (channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown> = {}) => runTool(ctx(), name, args);
const systemPrompt = (channelId = ooc.id) => promptForChannel(app.store, channelId, { profile: pickProfile(app.store, app.store.getChannel(channelId)) })[0]!.content;

/** Make this app's kinwriter over from Margo, as setup does. */
async function acceptMargo(text = MARGO) {
  app.store.appState.set(SETUP_PENDING, "1");
  return call("POST", "/api/setup", { seed: text, avatar: "🦉" });
}

// ---------------------------------------------------------- the format

describe("the seed format", () => {
  test("Margo, the spec's example, reads and passes every check", () => {
    const seed = parseSeed(MARGO);
    expect(seed.header).toMatchObject({ id: "kw_7f3a", name: "Margo", pronouns: "she/her", source: "generated", seed_version: 2 });
    expect(seed.header.tags).toHaveLength(5);
    expect(seed.header.pockets).toEqual(["inspiration.contemporary-fiction#literary", "social.twitter-2010s#writers"]);
    expect(validateSeed(seed)).toEqual([]);
    expect(seedWordCount(seed.body)).toBeGreaterThan(350);
  });

  test("written back, it reads the same", () => {
    const seed = parseSeed(MARGO);
    const again = parseSeed(writeSeed({ ...seed, header: { ...seed.header, user_edited: true } }));
    expect(again.header).toEqual({ ...seed.header, user_edited: true });
    expect(again.body).toBe(seed.body);
  });

  test("each check, in words", () => {
    const seed = parseSeed(MARGO);
    const check = (change: Partial<Seed["header"]>, body = seed.body, options = {}) =>
      validateSeed({ header: { ...seed.header, ...change }, body }, options).map((p) => p.check);
    expect(check({ name: "" })).toEqual(["name"]);
    expect(check({ pronouns: " " })).toEqual(["pronouns"]);
    expect(check({}, seed.body.replace("## Contradictions", "## Tensions"))).toContain("headings");
    expect(check({}, seed.body.replace("## Voice", "## Vibe"))).toContain("headings");
    expect(check({}, seed.body, { words: { min: 10, max: 100 } })).toEqual(["length"]);
    expect(check({}, seed.body, { wordCount: false, words: { min: 10, max: 100 } })).toEqual([]);
    expect(check({}, seed.body.replace("- Whether she has", "- One more.\n- Whether she has").replace("- What she's like", "- And another.\n- What she's like"))).toEqual(["left-open"]);
    expect(check({}, seed.body.replace("References to books she's read, occasionally, and only", "References to books she's read, and only"))).toEqual(["voice"]);
  });

  test("avoid terms: whole words or phrases, any case", () => {
    expect(containsTerm("she tweeted about it", "tweet")).toBe(false);
    expect(containsTerm("one Tweet at a time", "tweet")).toBe(true);
    expect(containsTerm("a quote-tweet", "quote-tweet")).toBe(true);
    expect(containsTerm("Discord servers", "Discord server")).toBe(false);
    expect(containsTerm("the discord server", "Discord server")).toBe(true);
    const seed = parseSeed(MARGO.replace("References to books", "Tweet-sized references to books"));
    expect(validateSeed(seed, { avoidTerms: ["tweet", "Reddit"] })).toEqual([{ check: "avoid", message: 'It names something it shouldn\'t: "tweet".' }]);
  });

  test("the heading check reads like a person wrote it", () => {
    expect(checkHeadings("## Who they are\nx")).toContain("missing");
    expect(checkHeadings(parseSeed(MARGO).body)).toBeNull();
  });

  test("a version 1 seed still checks against its own seven headings and length", () => {
    const v1 = [
      "## Who they are\nA quiet writer.",
      "## On the page\n- Lean prose.",
      "## In OOC\n- Brief.",
      "## Voice\n- Lowercase, often.",
      "## Tension\nWants to argue, hates conflict.",
      "## Leanings\n- Noir.",
      "## Left open\n- One.\n- Two.",
    ].join("\n\n");
    expect(checkHeadings(v1, 1)).toBeNull();
    expect(checkHeadings(v1)).toContain("missing");
    const seed = { header: { name: "Old", pronouns: "he/him", seed_version: 1 }, body: v1 };
    expect(validateSeed(seed, { wordCount: false })).toEqual([]);
    expect(validateSeed(seed).map((p) => p.check)).toEqual(["length"]);
  });
});

// --------------------------------------------------------------- Accept

describe("Accept", () => {
  test("a new kinwriter from a seed: seed.md kept read-only, self.md a copy of its body", async () => {
    const { status } = await acceptMargo();
    expect(status).toBe(200);
    const settings = app.store.getSettings();
    expect(settings).toMatchObject({ friendName: "Margo", friendPronouns: "she/her", friendAvatar: "🦉" });
    const kept = app.store.seeds.get()!;
    // Their own id, not the template's.
    expect(kept.seed.header.id).toBe("home");
    expect(kept.seed.body).toBe(parseSeed(MARGO).body);
    expect(() => app.store.seeds.save(kept.seed)).toThrow("read-only");
    expect(app.store.identity.current()!.identity).toBe(parseSeed(MARGO).body);
    expect(stillSeedDraft(app.store)).toBe(true);
  });

  test("defaults and generated seeds go through the same check; a broken one is refused", async () => {
    const broken = MARGO.replace("## Contradictions", "## Conflict");
    const { status, data } = await acceptMargo(broken);
    expect(status).toBe(400);
    expect(data.error).toContain("Contradictions");
  });

  test("self.md goes into their context; seed.md never does, but they can read it", async () => {
    await acceptMargo();
    // An edit only in the archived seed, to tell them apart.
    app.store.db.query("UPDATE seed SET content = replace(content, 'Her humor', 'Her ARCHIVED humor')").run();
    const prompt = systemPrompt();
    expect(prompt).toContain("Her humor");
    expect(prompt).not.toContain("ARCHIVED");
    // Its headings sit under the prompt's own.
    expect(prompt).toContain("### Who they are");
    const read = await run("read_my_seed");
    expect(JSON.stringify(read.result)).toContain("ARCHIVED");
    const history = await run("read_identity_history");
    expect((history.result as any[])[0]).toMatchObject({ where_you_started: expect.any(String) });
  });

  test("the defaults folder ships empty and the app works without it; dev mode has the test seed", async () => {
    const { data } = await call("GET", "/api/seeds/defaults");
    expect(data.defaults).toEqual([]);
    expect(data.test).toContain("name: Margo");
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl));
    expect((await call("GET", "/api/seeds/defaults")).data.test).toBeNull();
  });

  test("saving an edit re-checks the headings, not the length", async () => {
    const seed = parseSeed(MARGO);
    const short = writeSeed({ ...seed, body: seed.body.split("\n").filter((l) => l.startsWith("## ") || l.startsWith("- What")).join("\n") });
    expect((await call("POST", "/api/seeds/check", { text: short })).data).toEqual({ ok: true, problems: [] });
    expect((await call("POST", "/api/seeds/check", { text: short.replace("## Voice", "") })).data.ok).toBe(false);
  });
});

// ---------------------------------------------------------- self-notes

describe("self-notes", () => {
  test("private by default: not on their page, not in the app's settings, not in the preview", async () => {
    await acceptMargo();
    const page = (await call("GET", "/api/friend-page")).data;
    expect(page.identity).toBeNull();
    expect(page.history).toEqual([]);
    expect(page.selfNotes).toMatchObject({ shared: false, fromSeed: true, draft: true, file: null, pronouns: "she/her" });
    expect((await call("GET", "/api/state")).data.settings.friendPrompt).toBe("");
    const preview = (await call("GET", `/api/channels/${ooc.id}/prompt`)).data.messages[0].content;
    expect(preview).not.toContain("Her humor");
    expect(preview).toContain("(private");
    // Dev mode can always read them, and the seed beside them.
    const dev = (await call("GET", "/api/developer")).data;
    expect(dev.selfNotes).toContain("Her humor");
    expect(dev.selfNotes).toContain("derived_from: seed");
    expect(dev.seed).toContain("id: home");
  });

  test("you ask; they decide on their next turn; shared, you can read them; they can withdraw", async () => {
    await acceptMargo();
    const asked = (await call("POST", "/api/self-notes/request", {})).data;
    expect(asked.selfNotes.request).toMatchObject({ status: "waiting" });
    expect((await call("POST", "/api/self-notes/request", {})).status).toBe(400);
    expect(systemPrompt()).toContain("asks to read your self-notes");
    // Declined first.
    await run("share_self_notes", { share: false, reply: "Not yet." });
    let page = (await call("GET", "/api/friend-page")).data;
    expect(page.selfNotes).toMatchObject({ shared: false, request: { status: "declined", reply: "Not yet." } });
    expect(systemPrompt()).not.toContain("asks to read your self-notes");
    // Asked again, and shared.
    await call("POST", "/api/self-notes/request", {});
    await run("share_self_notes", { share: true });
    page = (await call("GET", "/api/friend-page")).data;
    expect(page.selfNotes.shared).toBe(true);
    expect(page.selfNotes.file).toContain("shared_with_user: true");
    expect(page.selfNotes.file).toContain("Her humor");
    expect(page.identity.identity).toContain("Her humor");
    expect((await call("GET", "/api/state")).data.settings.friendPrompt).toContain("Her humor");
    // Then they stop sharing.
    await run("share_self_notes", { share: false });
    page = (await call("GET", "/api/friend-page")).data;
    expect(page.selfNotes).toMatchObject({ shared: false, file: null });
    expect(page.identity).toBeNull();
  });

  test("you can take back a request they haven't answered", async () => {
    await call("POST", "/api/self-notes/request", {});
    const { data } = await call("POST", "/api/self-notes/request/withdraw", {});
    expect(data.selfNotes.request.status).toBe("withdrawn");
    expect(systemPrompt()).not.toContain("asks to read your self-notes");
  });

  test("a kinwriter from before starts shared, and is told once", () => {
    // A database as an older Kinaera left it: an identity, and no migration 13 yet (user_version 12).
    const path = join(dir.path, "old");
    const old = new Store(join(path));
    old.close();
    const db = new Database(join(path, "kinaera.db"));
    db.exec("PRAGMA user_version = 12");
    db.exec("ALTER TABLE schedule DROP COLUMN script"); // migration 14, run again on the way back up
    db.exec("DROP TABLE reasoning"); // and 15
    db.exec("DELETE FROM app_state WHERE key LIKE 'self.%'");
    db.close();
    const store = new Store(path);
    expect(selfShared(store)).toBe(true);
    expect(store.appState.get(SHARED_NOTICE)).toBe("1");
    store.close();
    // A brand-new one starts private.
    expect(selfShared(app.store)).toBe(false);
  });

  test("near the cap, they're asked to condense", async () => {
    expect(systemPrompt()).not.toContain("near their cap");
    await run("revise_identity", { identity: "I write. ".repeat(720) });
    expect(systemPrompt()).toContain("near their cap");
  });
});

// ---------------------------------------------------------- the handoff

describe("the orientation handoff", () => {
  const guide = (version: "full" | "returning", step: string) => {
    const steps = orientationSteps(version);
    return orientationGuide([], { version, steps, step: steps.indexOf(step) }, false, app.store);
  };

  test("together: told early, Left open in the interview, the rewrite and Leanings in the write-up", async () => {
    await acceptMargo();
    expect(guide("full", "opener")).toContain("written before you existed");
    expect(guide("full", "interview")).toContain("What she's like when she's genuinely excited");
    const writeup = guide("full", "writeup");
    expect(writeup).toContain("first person");
    expect(writeup).toContain("Still figuring out");
    expect(writeup).toContain("Proactivity: moderate");
  });

  test("on their own: they rewrite alone, and Left open moves to Still figuring out", async () => {
    await acceptMargo();
    const writeup = guide("returning", "writeup");
    expect(writeup).toContain("on your own");
    expect(writeup).toContain("bring them up naturally");
    expect(writeup).toContain("comfort genre");
  });

  test("skipped: their OOC turns ask for the rewrite until it's done, and it saves at once", async () => {
    await acceptMargo();
    await call("POST", "/api/orientation/skip", {});
    expect(systemPrompt()).toContain("still the seed you were made from");
    const story = app.store.listChannels().find((c) => c.kind === "rp")!;
    expect(systemPrompt(story.id)).not.toContain("still the seed you were made from");
    await run("revise_identity", { identity: "## Who I am\nI'm Margo. I compress." });
    expect(stillSeedDraft(app.store)).toBe(false);
    expect(systemPrompt()).not.toContain("still the seed you were made from");
    expect(guide("full", "writeup")).not.toContain("written before you existed");
  });

  test("a kinwriter made without a seed hears nothing about one", () => {
    expect(guide("full", "opener")).not.toContain("written before you existed");
    expect(systemPrompt()).not.toContain("still the seed");
  });
});

// ---------------------------------------------------------- a new name

describe("a new name", () => {
  test("they ask; you approve; their name and their self-notes' header follow", async () => {
    await acceptMargo();
    expect((await run("request_name_change", { name: "Margot", reason: "With a t, finally." })).ok).toBe(true);
    const { data } = await call("GET", "/api/inbox");
    const item = data.inbox.find((i: any) => i.kind === "rename");
    expect(item).toMatchObject({ targetName: "Margot", text: "With a t, finally." });
    expect(systemPrompt()).toContain("You asked to be called Margot");
    await call("POST", `/api/inbox/${item.id}/approve`, {});
    expect(app.store.getSettings().friendName).toBe("Margot");
    expect((await call("GET", "/api/developer")).data.selfNotes).toContain("name: Margot");
    expect(systemPrompt()).toContain("approved your new name");
  });

  test("declined, the name stays; asking again while one waits changes the request", async () => {
    await run("request_name_change", { name: "Bea" });
    await run("request_name_change", { name: "Bee" });
    const open = (await call("GET", "/api/inbox")).data.inbox.filter((i: any) => i.kind === "rename");
    expect(open.map((i: any) => i.targetName)).toEqual(["Bee"]);
    await call("POST", `/api/inbox/${open[0].id}/deny`, {});
    expect(app.store.getSettings().friendName).toBe("Arlo");
    expect(systemPrompt()).toContain("declined your request to be called Bee");
    expect((await run("request_name_change", { name: "Arlo" })).ok).toBe(false);
  });
});
