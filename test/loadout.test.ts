/**
 * Tests for the Profiles page's loadout (public/js/loadout.js): what each
 * job uses, and how a profile's settings are drawn.
 */

import { describe, expect, test } from "bun:test";

/** The browser module, loaded as plain JavaScript (it has no TypeScript types). */
const LOADOUT_JS = "../public/js/loadout.js";
const loadout: any = await import(LOADOUT_JS);

const profile = {
  id: "p1",
  name: "DeepSeek, warm",
  model: "deepseek-ai/DeepSeek-V3.1-Terminus",
  temperature: 0.9,
  maxTokens: 1024,
  topP: null,
  minP: 0.05,
  reasoningEffort: "low",
  supportsTools: true,
  consultant: false,
  kinwriterMaker: true,
  quirkPrompt: "",
  extraParams: "",
};

const settings = {
  rpAssignment: "profile:p1",
  oocAssignment: "",
  summaries: true,
  summaryAssignment: "",
  heartbeatAssignment: "roulette:r1",
  decisionModel: "typesafe/jev-1.13",
  decisionConfidence: 0.8,
  decisionFallback: "",
};

describe("loadoutJobs", () => {
  test("lists every job, with what an empty choice means", () => {
    const jobs = loadout.loadoutJobs(settings, [], []);
    expect(jobs.map((j: any) => j.job)).toEqual(["Roleplay", "OOC chat", "Summaries", "Heartbeat check", "Jev", "If Jev can't answer"]);
    expect(jobs[2].value).toEqual({ same: "Same as roleplay" });
    expect(jobs[3].value).toBe("roulette:r1");
    expect(jobs[4].value).toEqual({ model: "typesafe/jev-1.13", confidence: 0.8 });
    expect(jobs[5].value).toEqual({ none: "Nobody" });
  });

  test("marks sections set just for this kinwriter, and adds channels with their own choice", () => {
    const jobs = loadout.loadoutJobs({ ...settings, summaries: false }, [
      { name: "story", assignment: "profile:p2" },
      { name: "ooc", assignment: null },
    ], ["models"]);
    expect(jobs[0].own).toBe(true);
    expect(jobs[1].own).toBe(true);
    expect(jobs[2]).toMatchObject({ value: { none: "Summaries off" }, own: false });
    expect(jobs.at(-1)).toMatchObject({ job: "#story", value: "profile:p2", channel: true });
    expect(jobs).toHaveLength(7);
  });
});

describe("profileGauges", () => {
  test("numbers get bars, auto gets none", () => {
    const rows = loadout.profileGauges(profile, null);
    expect(rows.map((r: any) => r.label)).toEqual(["Temperature", "Max tokens", "Top P", "Min P", "Reasoning"]);
    expect(rows[0]).toMatchObject({ value: "0.9", fill: 0.45 });
    expect(rows[1].fill).toBeCloseTo(1024 / 32000);
    expect(rows[2]).toEqual({ label: "Top P", value: "auto" });
    expect(rows[3]).toMatchObject({ value: "0.05", fill: 0.05 });
    expect(rows[4]).toMatchObject({ value: "Low effort", steps: 1 });
  });

  test("follows what the model supports", () => {
    const rows = loadout.profileGauges(profile, { reasoning: false, maxOutputTokens: 2048 });
    expect(rows.map((r: any) => r.label)).not.toContain("Reasoning");
    expect(rows[1]).toMatchObject({ fill: 0.5, scale: "of 2048 (model's limit)" });
    // A profile asking for more than the model allows shows a full bar, not an overflowing one.
    expect(loadout.profileGauges({ ...profile, maxTokens: 9000 }, { maxOutputTokens: 2048 })[1].fill).toBe(1);
  });

  test("the model's default reasoning lights no step", () => {
    const rows = loadout.profileGauges({ ...profile, reasoningEffort: null }, null);
    expect(rows[4]).toMatchObject({ value: "The model's default", steps: -1 });
  });
});

test("profileSwitches", () => {
  expect(loadout.profileSwitches(profile)).toEqual([
    { label: "Can use tools", on: true },
    { label: "Consultant", on: false },
    { label: "Creates kinwriters", on: true },
  ]);
});

test("rouletteShares", () => {
  const shares = loadout.rouletteShares(
    { entries: [{ profileId: "p1", weight: 2 }, { profileId: "gone", weight: 3 }] },
    [profile],
  );
  expect(shares).toEqual([
    { name: "DeepSeek, warm", weight: 2, share: 40 },
    { name: "?", weight: 3, share: 60 },
  ]);
});

test("shortNumber drops float noise", () => {
  expect(loadout.shortNumber(0.1 + 0.2)).toBe("0.3");
  expect(loadout.shortNumber(1)).toBe("1");
});
