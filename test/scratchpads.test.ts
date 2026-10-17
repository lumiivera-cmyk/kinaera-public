/**
 * Tests for scratchpads (src/scratchpads.ts): a story channel's loose
 * notes, kept out of the notebook. The shared one is yours and your
 * kinwriter's; yours is never sent to them; theirs never shows on your
 * screens or in a log.
 *
 * Model calls go to a fake nanoGPT (see helpers.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { developerView } from "../src/developer.ts";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { appendToPad, getPad, mergeText, PadChangedError, PADS_INTRODUCED, toNotebook, undoPad, writePad } from "../src/scratchpads.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
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
  app.store.appState.set("orientation.pending", null);
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

const ctx = (channel: Channel = story): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown>, channel: Channel = story) => runTool(ctx(channel), name, args);
const systemPrompt = (channel: Channel = story, preview = false) =>
  promptForChannel(app.store, channel.id, { profile: pickProfile(app.store, channel), preview })[0]!.content;

describe("a pad", () => {
  test("keeps the version before each change, for undo", () => {
    writePad(app.store, story.id, "shared", "Kestrel is on the roof.", "user");
    appendToPad(app.store, story.id, "shared", "The bell is cracked.", "kinwriter");
    expect(getPad(app.store, story.id, "shared")).toMatchObject({ text: "Kestrel is on the roof.\nThe bell is cracked.", by: "kinwriter" });
    undoPad(app.store, story.id, "shared", "user");
    expect(getPad(app.store, story.id, "shared").text).toBe("Kestrel is on the roof.");
    // Undo again puts it back.
    undoPad(app.store, story.id, "shared", "user");
    expect(getPad(app.store, story.id, "shared").text).toContain("cracked");
  });

  test("refuses a write from a version that's no longer the latest", () => {
    const opened = writePad(app.store, story.id, "shared", "One.", "user");
    appendToPad(app.store, story.id, "shared", "Two.", "kinwriter");
    expect(() => writePad(app.store, story.id, "shared", "Mine.", "user", opened.rev)).toThrow(PadChangedError);
    expect(() => writePad(app.store, story.id, "shared", "Mine.", "user", 0)).toThrow(PadChangedError);
    expect(getPad(app.store, story.id, "shared").text).toBe("One.\nTwo.");
  });

  test("has a length limit", () => {
    expect(() => writePad(app.store, story.id, "shared", "x".repeat(20_000), "user")).toThrow(/too long/);
  });

  test("goes when its channel does", () => {
    writePad(app.store, story.id, "kinwriter", "A secret.", "kinwriter");
    app.store.deleteChannel(story.id);
    expect(app.store.appState.get(`scratchpad:${story.id}:kinwriter`)).toBeNull();
  });
});

describe("their tools", () => {
  test("add to the shared pad, change a passage, and rewrite it", async () => {
    expect((await run("write_scratchpad", { text: "Ilse has the key." })).summary).toBe('added to the scratchpad in #story: "Ilse has the key."');
    await run("write_scratchpad", { text: "The tide is out." });
    const changed = await run("write_scratchpad", { find: "the key", text: "the lamp" });
    expect(changed).toMatchObject({ ok: true });
    expect(getPad(app.store, story.id, "shared").text).toBe("Ilse has the lamp.\nThe tide is out.");
    await run("write_scratchpad", { find: "The tide is out.", text: "" });
    expect(getPad(app.store, story.id, "shared").text).toBe("Ilse has the lamp.");
    await run("write_scratchpad", { how: "replace", text: "Tidy." });
    expect(getPad(app.store, story.id, "shared")).toMatchObject({ text: "Tidy.", by: "kinwriter" });
  });

  test("explain what went wrong", async () => {
    await run("write_scratchpad", { text: "bell, bell" });
    expect((await run("write_scratchpad", { find: "missing", text: "x" })).summary).toMatch(/doesn't contain/);
    expect((await run("write_scratchpad", { find: "bell", text: "x" })).summary).toMatch(/2 times/);
    expect((await run("write_scratchpad", { text: "x" }, ooc)).summary).toMatch(/Name one with "channel"/);
    expect((await run("write_scratchpad", { text: "x", channel: "#ooc" }, ooc)).summary).toMatch(/isn't a story channel.*#story/);
  });

  test("work from OOC on a named story channel, and read it back", async () => {
    await run("write_private_scratchpad", { text: "Ilse is lying about the bell.", channel: "#story" }, ooc);
    await run("write_scratchpad", { text: "Next: the storm.", channel: "story" }, ooc);
    const read = await run("read_scratchpad", { channel: "#story" }, ooc);
    expect(read.result).toMatchObject({ shared: { text: "Next: the storm." }, private: { text: "Ilse is lying about the bell." } });
  });

  test("never reach your own pad", async () => {
    writePad(app.store, story.id, "user", "MY-SECRET plan", "user");
    const read = await run("read_scratchpad", { channel: "#story" });
    expect(JSON.stringify(read.result)).not.toContain("MY-SECRET");
    expect(systemPrompt()).not.toContain("MY-SECRET");
  });

  test("are offered in story and OOC channels", () => {
    const names = (c: Channel) => toolSpecs(ctx(c)).map((t) => t.function.name);
    expect(names(story)).toContain("write_private_scratchpad");
    expect(names(ooc)).toContain("read_scratchpad");
  });
});

describe("in their prompt", () => {
  test("the shared pad and theirs, in a story channel only", () => {
    writePad(app.store, story.id, "shared", "SHARED-NOTE", "user");
    writePad(app.store, story.id, "kinwriter", "THEIR-NOTE", "kinwriter");
    const prompt = systemPrompt();
    expect(prompt).toContain("## Scratchpad");
    expect(prompt).toContain("Shared with the user (last changed by the user just now):\nSHARED-NOTE");
    expect(prompt).toContain("only you see it (last changed by you just now):\nTHEIR-NOTE");
    expect(systemPrompt(ooc)).not.toContain("SHARED-NOTE");
  });

  test("empty pads still show, so they know they're there", () => {
    expect(systemPrompt()).toContain("Shared with the user (never written):\n(empty)");
  });

  test("the preview doesn't show theirs", async () => {
    writePad(app.store, story.id, "kinwriter", "THEIR-NOTE", "kinwriter");
    expect(systemPrompt(story, true)).not.toContain("THEIR-NOTE");
    expect(JSON.stringify((await call("GET", `/api/channels/${story.id}/prompt`)).data)).not.toContain("THEIR-NOTE");
  });

  test("they're told about them once", async () => {
    expect(systemPrompt()).toContain("New: each story channel now has scratchpads");
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(app.store.appState.get(PADS_INTRODUCED)).not.toBeNull();
    expect(systemPrompt()).not.toContain("New: each story channel now has scratchpads");
  });
});

describe("privacy", () => {
  test("their private pad is never in the tool log or your view, only the developer panel", async () => {
    fake.replies.push({ toolCalls: [{ name: "write_private_scratchpad", arguments: { text: "SECRET-PLAN for the bell" } }] }, { content: "Hm." });
    await call("POST", `/api/channels/${story.id}/turn`, {});
    expect(getPad(app.store, story.id, "kinwriter").text).toBe("SECRET-PLAN for the bell");
    const log = JSON.stringify(app.store.toolLog.forChannel(story.id));
    expect(log).toContain("write_private_scratchpad");
    expect(log).not.toContain("SECRET-PLAN");
    const view = (await call("GET", `/api/channels/${story.id}/scratchpads`)).data;
    expect(JSON.stringify(view)).not.toContain("SECRET-PLAN");
    expect(view.theirs).toEqual({ written: true });
    expect(developerView(app.store).privateScratchpads).toEqual([expect.objectContaining({ channel: "story", text: "SECRET-PLAN for the bell" })]);
  });
});

describe("the API", () => {
  test("reads and writes the shared pad and yours, from the version you opened", async () => {
    let { data } = await call("GET", `/api/channels/${story.id}/scratchpads`);
    expect(data.shared).toMatchObject({ text: "", at: null, rev: 0 });
    ({ data } = await call("PUT", `/api/channels/${story.id}/scratchpads/mine`, { text: "Mine.", base: 0 }));
    expect(data.mine).toMatchObject({ text: "Mine.", by: "user" });
    expect(getPad(app.store, story.id, "user").text).toBe("Mine.");

    const opened = (await call("PUT", `/api/channels/${story.id}/scratchpads/shared`, { text: "Ours.", base: 0 })).data.shared.rev;
    appendToPad(app.store, story.id, "shared", "Theirs too.", "kinwriter");
    const conflict = await call("PUT", `/api/channels/${story.id}/scratchpads/shared`, { text: "Overwrite", base: opened });
    expect(conflict.status).toBe(409);
    expect(getPad(app.store, story.id, "shared").text).toBe("Ours.\nTheirs too.");

    ({ data } = await call("POST", `/api/channels/${story.id}/scratchpads/shared/undo`, {}));
    expect(data.shared.text).toBe("Ours.");
  });

  test("only story channels have them, and theirs can't be reached", async () => {
    expect((await call("GET", `/api/channels/${ooc.id}/scratchpads`)).status).toBe(400);
    expect((await call("PUT", `/api/channels/${story.id}/scratchpads/kinwriter`, { text: "x" })).status).toBe(404);
  });
});

describe("merging, like a shared document", () => {
  test("keeps both people's changes", () => {
    const base = "Kestrel is on the roof.\nThe bell is cracked.";
    // They add a line while you fix another.
    expect(mergeText(base, "Kestrel is on the stairs.\nThe bell is cracked.", `${base}\nIlse has the key.`)).toBe(
      "Kestrel is on the stairs.\nThe bell is cracked.\nIlse has the key.",
    );
    // Both add at the end: yours, then theirs.
    expect(mergeText(base, `${base}\nMine.`, `${base}\nTheirs.`)).toBe(`${base}\nMine.\nTheirs.`);
    // Both change the same line differently: nothing is lost.
    expect(mergeText("a\nb\nc", "a\nB1\nc", "a\nB2\nc")).toBe("a\nB1\nB2\nc");
    // Only one of you changed it.
    expect(mergeText(base, base, "Theirs.")).toBe("Theirs.");
    expect(mergeText(base, "", base)).toBe("");
  });

  test("both changed the same lines: their blank and repeated lines are kept", () => {
    expect(mergeText("a\nb\nc", "a\nX\nc", "a\nY\n\nY\nX\nc")).toBe("a\nX\nY\n\nY\nc");
  });

  test("very long texts fall back to keeping both, without the line-by-line comparison", () => {
    const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const merged = mergeText(base, `${base}\nMine.`, `${base}\nTheirs.`);
    expect(merged.startsWith(`${base}\nMine.`)).toBe(true);
    expect(merged.endsWith("Theirs.")).toBe(true);
  });

  test("the API merges your save with their change since you opened it", async () => {
    const opened = (await call("PUT", `/api/channels/${story.id}/scratchpads/shared`, { text: "One.\nTwo." })).data.shared.text;
    await run("write_scratchpad", { text: "Theirs." });
    const { status, data } = await call("PUT", `/api/channels/${story.id}/scratchpads/shared`, { text: "One!\nTwo.", baseText: opened });
    expect(status).toBe(200);
    expect(data.shared.text).toBe("One!\nTwo.\nTheirs.");
  });
});

describe("saving to the notebook", () => {
  test("a new lore entry, pinned here, and the note leaves the pad", () => {
    writePad(app.store, story.id, "shared", "Where: lamp room.\nThe bell was cast in 1802.\nLater: storm.", "user");
    const saved = toNotebook(app.store, story.id, "shared", "user", { passage: "The bell was cast in 1802.", name: "The Bell", pin: true });
    expect(saved).toMatchObject({ created: true, pinned: true, suggested: false, entry: { name: "The Bell", kind: "lore" } });
    const entry = app.store.notebook.getEntry("user", saved.entry.id);
    expect(entry.fields.find((f) => f.label === "Details")?.value).toBe("The bell was cast in 1802.");
    expect(entry.pinnedIn).toContain(story.id);
    expect(getPad(app.store, story.id, "shared").text).toBe("Where: lamp room.\nLater: storm.");
  });

  test("added to an existing entry's field, kept in the pad if asked", () => {
    const ilse = app.store.notebook.listEntries("user").find((e) => e.name === "Ilse Marrow")!;
    writePad(app.store, story.id, "user", "Ilse hums when she lies.", "user");
    toNotebook(app.store, story.id, "user", "user", { passage: "Ilse hums when she lies.", entryId: ilse.id, field: "Speech", keep: true });
    expect(app.store.notebook.getEntry("user", ilse.id).fields.find((f) => f.label === "Speech")?.value).toEndWith("Ilse hums when she lies.");
    expect(getPad(app.store, story.id, "user").text).toBe("Ilse hums when she lies.");
  });

  test("only a suggestion: the passage stays in the pad", () => {
    const lamp = app.store.notebook.createEntry("user", { kind: "lore", name: "The Lamp", editing: "suggest" });
    writePad(app.store, story.id, "shared", "The lamp is brass.", "user");
    const saved = toNotebook(app.store, story.id, "shared", "kinwriter", { passage: "The lamp is brass.", entryId: lamp.id });
    expect(saved.suggested).toBe(true);
    expect(getPad(app.store, story.id, "shared").text).toBe("The lamp is brass.");
  });

  test("refuses a name that's taken, or text that isn't there", () => {
    writePad(app.store, story.id, "shared", "A note.", "user");
    expect(() => toNotebook(app.store, story.id, "shared", "user", { passage: "A note.", name: "ilse marrow" })).toThrow(/already an entry/);
    expect(() => toNotebook(app.store, story.id, "shared", "user", { passage: "Gone.", name: "X" })).toThrow(/isn't in the scratchpad/);
  });

  test("their tool: a new entry from their private pad starts hidden", async () => {
    writePad(app.store, story.id, "kinwriter", "Ilse's brother drowned at the bell.", "kinwriter");
    const outcome = await run("scratchpad_to_notebook", { pad: "private", passage: "Ilse's brother drowned at the bell.", entry: "The Drowning", kind: "lore" });
    expect(outcome).toMatchObject({ ok: true, summary: "saved a note to the notebook as The Drowning" });
    expect(app.store.notebook.listEntries("user").some((e) => e.name === "The Drowning")).toBe(false);
    expect(app.store.notebook.listEntries("kinwriter").find((e) => e.name === "The Drowning")).toMatchObject({ visibility: "hidden" });
    expect(getPad(app.store, story.id, "kinwriter").text).toBe("");
  });

  test("their tool: added to an existing entry by name, and explained when the note isn't there", async () => {
    writePad(app.store, story.id, "shared", "Ilse limps.", "user");
    expect((await run("scratchpad_to_notebook", { passage: "Nope.", entry: "Ilse Marrow" })).summary).toMatch(/doesn't contain/);
    const outcome = await run("scratchpad_to_notebook", { passage: "Ilse limps.", entry: "ilse marrow", field: "Appearance" });
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toMatch(/Ilse Marrow/);
  });

  test("the API, from your pads only", async () => {
    await call("PUT", `/api/channels/${story.id}/scratchpads/mine`, { text: "Secret door behind the lens." });
    const { status, data } = await call("POST", `/api/channels/${story.id}/scratchpads/mine/to-notebook`, { passage: "Secret door behind the lens.", name: "The Lens Door", kind: "lore" });
    expect(status).toBe(200);
    expect(data.saved).toMatchObject({ created: true, entry: { name: "The Lens Door" } });
    expect(data.mine.text).toBe("");
    expect((await call("POST", `/api/channels/${story.id}/scratchpads/kinwriter/to-notebook`, { passage: "x", name: "y" })).status).toBe(404);
  });
});
