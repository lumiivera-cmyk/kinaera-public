/**
 * Tests for orientation stage 3: the health view (src/health.ts), which
 * shows shape and never content, and the developer panel
 * (src/developer.ts), which only exists with DEVELOPER_PANEL=1 and is
 * disclosed in the kinwriter's prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pickProfile, promptForChannel } from "../src/kinwriter.ts";
import { FAILING_CALLS, healthReport, REWRITES_PER_DAY, SAME_FAILURE, UNKEPT_JOURNAL } from "../src/health.ts";
import { createApp, type App } from "../src/server.ts";
import type { Channel } from "../src/types.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;
let ooc: Channel;

function open(developerPanel = false) {
  app = createApp(testConfig(dir.path, fake.baseUrl, { developerPanel }));
  ooc = app.store.listChannels().find((c) => c.kind === "ooc")!;
}

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  open();
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

async function call(path: string) {
  const response = await app.fetch(new Request(`http://localhost${path}`));
  return { status: response.status, data: (await response.json()) as any };
}

/** A tool call in the log, as a turn would record it. */
function logged(name: string, args: string, status: "ok" | "error") {
  app.store.toolLog.add({ channelId: ooc.id, turnId: "t", round: 0, name, arguments: args, result: "{}", status, summary: "", source: "native", profile: null });
}

describe("the health view", () => {
  test("all well at first", async () => {
    const { data } = await call("/api/health");
    expect(data.findings).toEqual([expect.objectContaining({ level: "ok" })]);
  });

  test("tools that keep failing, and the very same call failing again and again", () => {
    for (let i = 0; i < FAILING_CALLS; i++) logged("delete_channel", '{"channel":"#story"}', "error");
    logged("delete_channel", '{"channel":"#other"}', "ok");
    const report = healthReport(app.store);
    expect(report.tools.find((t) => t.name === "delete_channel")).toMatchObject({ ok: 1, failed: FAILING_CALLS });
    const texts = report.findings.map((f) => f.text).join("\n");
    expect(texts).toContain(`delete_channel failed ${FAILING_CALLS} of ${FAILING_CALLS + 1} times`);
    expect(SAME_FAILURE).toBeLessThanOrEqual(FAILING_CALLS);
    expect(texts).toContain("with the very same arguments");
    // Shape only: the arguments themselves never appear.
    expect(JSON.stringify(report)).not.toContain("#story");
  });

  test("the same note rewritten over and over, a full section, an unkept journal; never the words", () => {
    for (let i = 0; i < REWRITES_PER_DAY; i++) logged("write_self_page", "(private)", "ok");
    app.store.selfPage.write("standing", "S".repeat(590));
    for (let i = 0; i < UNKEPT_JOURNAL; i++) app.store.journal.write(`SECRET-JOURNAL ${i}`);
    const report = healthReport(app.store);
    const texts = report.findings.map((f) => f.text).join("\n");
    expect(texts).toContain(`write_self_page ran ${REWRITES_PER_DAY} times in the last day`);
    expect(texts).toContain("Self-page: short version is at 98% of its limit");
    expect(texts).toContain(`The journal has ${UNKEPT_JOURNAL} entries and none kept`);
    expect(JSON.stringify(report)).not.toContain("SECRET-JOURNAL");
    expect(JSON.stringify(report)).not.toContain("SSSS");
  });
});

describe("the developer panel", () => {
  test("doesn't exist without DEVELOPER_PANEL=1", async () => {
    expect((await call("/api/developer")).status).toBe(404);
    expect((await call("/api/state")).data.developerPanel).toBe(false);
  });

  test("with it: every private note in one view", async () => {
    app.store.close();
    open(true);
    app.store.journal.write("A private thought.");
    app.store.drafts.create("A draft.", "Opening");
    const { status, data } = await call("/api/developer");
    expect(status).toBe(200);
    expect(data.journal.map((e: any) => e.content)).toEqual(["A private thought."]);
    expect(data.drafts[0]).toMatchObject({ title: "Opening", content: "A draft." });
    expect((await call("/api/state")).data.developerPanel).toBe(true);
  });

  test("is disclosed in their prompt, so \"private\" stays true", () => {
    const prompt = promptForChannel(app.store, ooc.id, { profile: pickProfile(app.store, ooc) })[0]!.content;
    expect(prompt).toContain("its developer may occasionally open your private notes");
    expect(prompt).toContain("Openings aren't logged or announced");
  });
});
