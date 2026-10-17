/**
 * Tests for scripts (src/scripts.ts): tools your kinwriter writes down in
 * order and runs exactly, in a turn (run_script) or on their own at a set
 * time (a tools-only turn), with a failure reported back so they can try
 * again from the step that failed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { Rhythms } from "../src/orientation.ts";
import { applicableReflexes, reflexesOff, setReflex } from "../src/reflexes.ts";
import { listScripts } from "../src/scripts.ts";
import { createApp, type App } from "../src/server.ts";
import { runTool, toolSpecs, type ToolContext } from "../src/tools.ts";
import { Wakeups } from "../src/wakeups.ts";
import { toolMap } from "../src/toolmap.ts";
import { scriptQueue } from "../src/scripts.ts";
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
  app.store.updateSettings({ scripts: true });
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

const ctx = (channel: Channel = ooc): ToolContext => ({ store: app.store, channel, mode: "post", turn: { consults: 0 } });
const run = (name: string, args: Record<string, unknown>, channel: Channel = ooc) => runTool(ctx(channel), name, args);
const names = (c: ToolContext) => toolSpecs(c).map((t) => t.function.name);

/** Two steps that work, then one that fails (no such entry), then one that never runs. */
const steps = [
  { tool: "write_map_entry", args: { tool: "check", when: "before I state a fact" } },
  { tool: "list_my_wakeups", args: {} },
  { tool: "read_notebook_entry", args: { name: "Nobody At All" } },
  { tool: "write_map_entry", args: { tool: "ask", when: "when I'm unsure what they meant" } },
];

describe("turning scripts on", () => {
  test("off by default: no script tools, and schedule_wakeup won't take a script", async () => {
    app.store.updateSettings({ scripts: false });
    expect(names(ctx())).not.toContain("save_script");
    expect(names(ctx())).not.toContain("run_script");
    const outcome = await run("schedule_wakeup", { when: "in 1 hour", script: "tidy" });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome.result)).toContain("turned off");
  });

  test("on: offered in a turn, not when replying to a comment", () => {
    for (const tool of ["save_script", "run_script", "list_my_scripts", "delete_script"]) expect(names(ctx())).toContain(tool);
    expect(names({ ...ctx(), mode: "comment" })).not.toContain("run_script");
  });

  test("the setting must be true or false", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scripts: "yes" }) }),
    );
    expect(response.status).toBe(400);
  });
});

describe("writing scripts", () => {
  test("steps are checked: known tools only, and not the ones a script can't call", async () => {
    expect((await run("save_script", { name: "x", steps: [] })).ok).toBe(false);
    const unknown = await run("save_script", { name: "x", steps: [{ tool: "fly_away", args: {} }] });
    expect(JSON.stringify(unknown.result)).toContain('no tool called \\"fly_away\\"');
    const nothing = await run("save_script", { name: "x", steps: [{ tool: "do_nothing" }] });
    expect(JSON.stringify(nothing.result)).toContain("can't be used in a script");
    expect((await run("save_script", { name: "x", steps: [{ tool: "run_script", args: { name: "x" } }] })).ok).toBe(false);
    expect(listScripts(app.store)).toEqual([]);
  });

  test("save, list, replace by name, delete", async () => {
    // Arguments as JSON text are fine too (some models send them that way).
    const saved = await run("save_script", { name: "Tidy", about: "my map", steps: [{ tool: "list_my_wakeups", args: "{}" }] });
    expect(saved.ok).toBe(true);
    expect(saved.summary).toBe('wrote their script "Tidy" (1 step)');
    const replaced = await run("save_script", { name: "tidy", steps: JSON.stringify(steps) });
    expect((replaced.result as any).replaced).toBe(true);
    const listed = ((await run("list_my_scripts", {})).result as any).scripts as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0].steps.map((s: any) => s.tool)).toEqual(steps.map((s) => s.tool));
    expect(listed[0].last_run).toBeNull();
    expect((await run("delete_script", { name: "TIDY" })).ok).toBe(true);
    expect(listScripts(app.store)).toEqual([]);
  });
});

describe("running a script in a turn", () => {
  test("runs in order, stops at the failing step and says so; a retry from that step finishes it", async () => {
    await run("save_script", { name: "tidy", steps });
    const outcome = await run("run_script", { name: "tidy" });
    expect(outcome.ok).toBe(false);
    const report = outcome.result as any;
    expect(report.failed_step).toBe(3);
    expect(report.error).toContain("Nobody At All");
    expect(report.retry).toContain('"from_step": 3');
    expect(report.steps.map((s: any) => [s.step, s.ok])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    // Step 1 happened; step 4 never ran.
    expect(Object.keys(toolMap(app.store))).toEqual(["check"]);
    expect(outcome.summary).toContain("stopped at step 3");
    expect(listScripts(app.store)[0]!.lastRun).toMatchObject({ ok: false, failedStep: 3, ran: 3 });

    // They fix the step (the entry exists now) and retry from it.
    app.store.notebook.createEntry("kinwriter", { name: "Nobody At All", kind: "character", fields: [] } as any);
    const retry = await run("run_script", { name: "tidy", from_step: 3 });
    expect(retry.ok).toBe(true);
    expect((retry.result as any).steps.map((s: any) => s.step)).toEqual([3, 4]);
    expect(Object.keys(toolMap(app.store)).sort()).toEqual(["ask", "check"]);
    expect((await run("run_script", { name: "tidy", from_step: 9 })).ok).toBe(false);
  });

  test("expect: a step whose result lacks the text fails; an optional step's failure doesn't stop the run", async () => {
    await run("save_script", {
      name: "careful",
      steps: [
        { tool: "read_notebook_entry", args: { name: "Nobody At All" }, optional: true },
        { tool: "write_map_entry", args: { tool: "check", when: "always" }, expect: "saved" },
        { tool: "list_my_wakeups", args: {}, expect: "lighthouse" },
      ],
    });
    const report = (await run("run_script", { name: "careful" })).result as any;
    expect(report.steps.map((s: any) => s.ok)).toEqual([false, true, false]);
    expect(report.failed_step).toBe(3);
    expect(report.error).toContain('didn\'t contain "lighthouse"');
  });
});

describe("a script on its own (a tools-only turn)", () => {
  const due = () => app.store.db.query("UPDATE schedule SET at = $at WHERE status = 'waiting'").run({ at: new Date(Date.now() - 60_000).toISOString() });
  const rhythms = () => new Rhythms(app.store, new Wakeups(app.store, app.kinwriter, true), () => new Date());

  test("every step works: no model call at all, each step in the tool log, and it's done", async () => {
    await run("save_script", {
      name: "hello",
      steps: [
        { tool: "write_map_entry", args: { tool: "check", when: "before facts" } },
        // A tools-only turn writes no reply, so it can post in its own channel.
        { tool: "post_in_channel", args: { channel: "here", text: "morning! thinking about the heist" } },
      ],
    });
    const scheduled = await run("schedule_wakeup", { when: "in 1 hour", script: "hello" });
    expect(scheduled.summary).toContain('scheduled their script "hello"');
    due();
    await rhythms().tick();
    expect(fake.requests).toHaveLength(0);
    expect(app.store.schedule.waiting()).toEqual([]);
    expect(app.store.getMessages(ooc.id).at(-1)!.content).toContain("thinking about the heist");
    const log = app.store.toolLog.forChannel(ooc.id, 10).filter((c) => c.summary.includes('(script "hello"'));
    expect(log.map((c) => [c.name, c.status])).toEqual([
      ["write_map_entry", "ok"],
      ["post_in_channel", "ok"],
    ]);
  });

  test("a step fails: they wake up to which step and why, and how to retry", async () => {
    await run("save_script", { name: "tidy", steps });
    await run("schedule_wakeup", { when: "in 1 hour", script: "tidy", note: "keep my map neat" });
    due();
    fake.replies.push({ content: "ugh, the entry's missing. I'll fix it later" });
    const result = await rhythms().tick();
    expect(result).toMatchObject({ reason: "scheduled", outcome: "posted" });
    expect(fake.requests).toHaveLength(1);
    const prompt = JSON.stringify(fake.requests[0]!.messages);
    expect(prompt).toContain('stopped at step 3 (read_notebook_entry)');
    expect(prompt).toContain('\\"from_step\\": 3');
    expect(prompt).toContain("keep my map neat");
    expect(app.store.schedule.waiting()).toEqual([]);
  });

  test("scripts turned off by the time it's due: nothing runs, and they're told", async () => {
    await run("save_script", { name: "tidy", steps });
    await run("schedule_wakeup", { when: "in 1 hour", script: "tidy" });
    app.store.updateSettings({ scripts: false });
    due();
    fake.replies.push({ content: "oh, scripts are off" });
    await rhythms().tick();
    expect(toolMap(app.store)).toEqual({});
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("scripts are turned off now");
  });

  test("quiet hours hold it, like a wake-up", async () => {
    await run("save_script", { name: "hello", steps: [{ tool: "list_my_wakeups", args: {} }] });
    await run("schedule_wakeup", { when: "in 1 hour", script: "hello" });
    const hour = new Date().getHours();
    app.store.updateSettings({ quietStart: hour, quietEnd: (hour + 1) % 24 });
    due();
    await rhythms().tick();
    expect(app.store.schedule.waiting()).toHaveLength(1);
    expect(app.store.schedule.waiting()[0]!.script).toBe("hello");
  });
});

// ------------------------------------------------------- long reads

/** A document of `n` passages, one per heading. */
function longDoc(n: number) {
  const parts = Array.from({ length: n }, (_, i) => `## Part ${i + 1}\n\n${`Passage ${i + 1} words. `.repeat(30)}`);
  return app.store.library.add({ title: "Long", content: parts.join("\n\n") });
}

/** Wait until no turn is running and none starts (another turn starts a moment after one ends). */
async function settle() {
  for (let quiet = 0; quiet < 5; ) {
    await Bun.sleep(20);
    quiet = app.kinwriter.busyChannels().length === 0 ? quiet + 1 : 0;
  }
}

const libraryLine = () => JSON.stringify(promptForChannel(app.store, ooc.id, { profile: pickProfile(app.store, ooc) })[0]!.content);

describe("reading a long document", () => {
  test("their place is kept, and shown beside the document; up to 5 passages a call; rereading doesn't lose it", async () => {
    const doc = longDoc(12);
    expect(doc.passages).toBe(12);
    const read = (await run("read_library", { document: "Long", passage: 1, count: 9 })).result as any;
    expect(read.passages).toHaveLength(5);
    expect(read.next).toBe(6);
    expect(libraryLine()).toContain("read up to passage 5; carry on from 6");
    await run("read_library", { document: "Long", passage: 2 });
    expect(libraryLine()).toContain("read up to passage 5");
    await run("read_library", { document: "Long", passage: 11, count: 5 });
    expect(libraryLine()).toContain("you've read all of it");
  });
});

describe("taking another turn", () => {
  test("they ask for one, and it follows with their note; it stops when they don't ask again", async () => {
    fake.replies.push({ toolCalls: [{ name: "take_another_turn", arguments: { note: "read from 6" } }] }, { content: "reading, back in a sec" }, { content: "[nothing]" });
    await app.kinwriter.takeTurn(ooc.id, "continue");
    await settle();
    expect(fake.requests).toHaveLength(3);
    expect(JSON.stringify(fake.requests[2]!.messages)).toContain('Your note for this turn: \\"read from 6\\"');
    expect(app.store.getMessages(ooc.id).filter((m) => m.author === "kinwriter").map((m) => m.content)).toEqual(["reading, back in a sec"]);
  });

  test("a script ending in take_another_turn: a real turn follows the tools-only one", async () => {
    await run("save_script", { name: "then talk", steps: [{ tool: "list_my_wakeups", args: {} }, { tool: "take_another_turn", args: { note: "tell them I'm up" } }] });
    fake.replies.push({ content: "morning!" });
    await app.kinwriter.runScriptTurn(ooc.id, "then talk");
    await settle();
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("tell them I'm up");
  });
});

test("Stop ends a script between steps, and no turn follows it", async () => {
  await run("save_script", {
    name: "stop me",
    steps: [
      { tool: "post_in_channel", args: { channel: "#story", text: "a line in the story" } },
      { tool: "write_map_entry", args: { tool: "check", when: "never reached" } },
      { tool: "take_another_turn", args: { note: "never reached either" } },
    ],
  });
  // Stop is pressed while the first step runs.
  app.kinwriter.onPostedElsewhere = () => app.kinwriter.cancelAll();
  await expect(app.kinwriter.runScriptTurn(ooc.id, "stop me")).rejects.toThrow("stopped");
  await settle();
  expect(app.store.toolLog.forChannel(ooc.id, 10).map((c) => c.name)).toEqual(["post_in_channel"]);
  expect(toolMap(app.store)).toEqual({});
  expect(fake.requests).toHaveLength(0);
});

describe("a script queue", () => {
  const readScript = (name: string, from: number) =>
    run("save_script", { name, steps: [{ tool: "read_library", args: { document: "Long", passage: from, count: 5 } }, { tool: "read_library", args: { document: "Long", passage: from + 5, count: 5 } }] });

  test("one script per turn, its results in front of them, until the queue is empty", async () => {
    longDoc(30);
    await readScript("read 1", 1);
    await readScript("read 2", 11);
    await readScript("read 3", 21);
    fake.replies.push({ toolCalls: [{ name: "queue_scripts", arguments: { scripts: ["read 1", "read 2", "read 3"] } }] }, { content: "settling in to read" });
    await app.kinwriter.takeTurn(ooc.id, "continue");
    await settle();
    // The queuing turn (two requests), then one turn per script.
    expect(fake.requests).toHaveLength(5);
    const turn = (i: number) => JSON.stringify(fake.requests[i]!.messages);
    expect(turn(2)).toContain('queued script \\"read 1\\" just ran');
    expect(turn(2)).toContain("Passage 10 words");
    expect(turn(2)).toContain("2 more queued");
    expect(turn(3)).toContain("Passage 20 words");
    expect(turn(4)).toContain("That was the last queued script");
    expect(scriptQueue(app.store)).toBeNull();
    expect(libraryLine()).toContain("you've read all of it");
  });

  test("a failed step pauses only that script; the rest of the plan is kept, and they can retry, restart, skip or insert", async () => {
    longDoc(30);
    await readScript("read 1", 1);
    await run("save_script", { name: "broken", steps: [{ tool: "read_library", args: { document: "Long", passage: 11 } }, { tool: "read_library", args: { document: "Long", passage: 99 } }] });
    await readScript("read 3", 21);
    await readScript("fix up", 16);
    fake.replies.push({ toolCalls: [{ name: "queue_scripts", arguments: { scripts: ["read 1", "broken", "read 3"] } }] }, { content: "ok" });
    await app.kinwriter.takeTurn(ooc.id, "continue");
    await settle();
    // Queuing turn, "read 1", then "broken" fails: no turn after that.
    expect(fake.requests).toHaveLength(4);
    expect(JSON.stringify(fake.requests[3]!.messages)).toContain("stopped at step 2");
    expect(scriptQueue(app.store)).toMatchObject({ paused: true, items: [{ name: "broken", from: 2 }, { name: "read 3", from: 1 }] });

    // Adding to the end keeps it paused and keeps the plan.
    await run("queue_scripts", { scripts: ["read 1"], add: true });
    expect(scriptQueue(app.store)!.items.map((i) => i.name)).toEqual(["broken", "read 3", "read 1"]);
    expect(scriptQueue(app.store)!.paused).toBe(true);

    // Restart it from step 1, with a fix-up first: the rest stays as it was.
    await run("resume_script_queue", { from_step: 1, insert: ["fix up"] });
    expect(scriptQueue(app.store)).toMatchObject({ paused: false, items: [{ name: "fix up" }, { name: "broken", from: 1 }, { name: "read 3" }, { name: "read 1" }] });
    expect((await run("resume_script_queue", { from_step: 7 })).ok).toBe(false);

    // Or skip it.
    app.store.appState.set("scripts.queue", JSON.stringify({ ...scriptQueue(app.store)!, paused: true, items: [{ name: "broken", from: 2 }, { name: "read 3", from: 1 }] }));
    const skipped = await run("resume_script_queue", { skip: true });
    expect((skipped.result as any).next).toEqual(["read 3"]);
  });
});

describe("introducing scripts", () => {
  test("told once, on the first turn after scripts are turned on, and pointed at their tool map", async () => {
    const prompt = () => JSON.stringify(promptForChannel(app.store, ooc.id, { profile: pickProfile(app.store, ooc) })[0]!.content);
    expect(prompt()).toContain("the user turned on scripts for you");
    expect(prompt()).toContain("write_map_entry");
    fake.replies.push({ content: "ooh" });
    await app.kinwriter.takeTurn(ooc.id, "continue");
    expect(JSON.stringify(fake.requests[0]!.messages)).toContain("the user turned on scripts for you");
    expect(prompt()).not.toContain("the user turned on scripts for you");
    // Off and on again: they already know.
    app.store.updateSettings({ scripts: false });
    app.store.updateSettings({ scripts: true });
    expect(prompt()).not.toContain("the user turned on scripts for you");
  });

  test("not while scripts are off", () => {
    app.store.updateSettings({ scripts: false });
    expect(JSON.stringify(promptForChannel(app.store, ooc.id, { profile: pickProfile(app.store, ooc) })[0]!.content)).not.toContain("turned on scripts");
  });
});

describe("the reflexes for scripts", () => {
  const ids = (kind: "ooc" | "rp" = "ooc", used: string[] = []) => applicableReflexes(app.store, kind, used).map((r) => r.id);

  test("carry-on is on (outside stories) and skipped once they've set up another turn; plan starts off", () => {
    expect(ids()).toContain("carry-on");
    expect(ids("rp")).not.toContain("carry-on");
    expect(ids("ooc", ["take_another_turn"])).not.toContain("carry-on");
    expect(ids("ooc", ["queue_scripts"])).not.toContain("carry-on");
    expect(ids()).not.toContain("plan");
    setReflex(app.store, "plan", true);
    expect(ids()).toContain("plan");
    expect(ids("rp")).toContain("plan");
  });

  test("only while scripts are on", async () => {
    setReflex(app.store, "plan", true);
    app.store.updateSettings({ scripts: false });
    expect(ids()).not.toContain("carry-on");
    expect(ids()).not.toContain("plan");
    app.store.updateSettings({ scripts: true, decisionModel: "typesafe/jev" });
    expect(((await runTool({ ...ctx(), decider: { enabled: () => true } as any }, "set_my_reflexes", {})).result as any[]).map((r) => r.check)).toContain("carry-on");
  });

  test("someone who chose their checks before plan existed doesn't get it turned on", () => {
    // Their list from before: lore turned on, so it isn't in the off list.
    app.store.appState.set("reflexes.off", JSON.stringify(["recall"]));
    expect(reflexesOff(app.store).has("plan")).toBe(true);
    expect(reflexesOff(app.store).has("lore")).toBe(false);
    setReflex(app.store, "plan", true);
    expect(reflexesOff(app.store).has("plan")).toBe(false);
    expect(reflexesOff(app.store).has("recall")).toBe(true);
  });
});
