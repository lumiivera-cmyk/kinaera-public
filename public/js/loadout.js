/**
 * The whole model loadout at a glance, for the Profiles page: who writes
 * what, and every setting of every profile and roulette, drawn so that a
 * screenshot is enough for someone else to set the same thing up.
 *
 * This file works out *what* to show from plain data (no page elements),
 * so it can be tested; settings.js draws it.
 *
 * - `loadoutJobs(settings, channels, ownSettings)`: each job (roleplay,
 *   OOC, summaries, the heartbeat check, Jev, Jev's fallback, channels with
 *   their own choice) with the assignment it uses and whether it's set
 *   "Just for" this kinwriter.
 * - `profileGauges(profile, info)`: a profile's settings as rows, each with
 *   a shown value and, for the numbers, how full its bar is (0 to 1).
 *   `info` is what nanoGPT says about the model (model-info.js), or null.
 * - `rouletteShares(roulette, profiles)`: each entry's name, weight and share.
 */

/** Which Settings section each job lives in, for "Just for …" (src/universal.ts). */
const SECTION = {
  rpAssignment: "models",
  oocAssignment: "models",
  summaryAssignment: "memory",
  heartbeatAssignment: "reaching",
};

const REASONING = { none: "Off", low: "Low effort", medium: "Medium effort", high: "High effort" };

/**
 * The jobs and what writes each. `value` is an assignment
 * ("profile:<id>", "roulette:<id>"), or what an empty one means:
 * `{ same: "rpAssignment" }`, `{ none: "No check" }` and so on.
 */
export function loadoutJobs(settings, channels = [], ownSettings = []) {
  const own = (key) => ownSettings.includes(SECTION[key]);
  const jobs = [
    { job: "Roleplay", value: settings.rpAssignment || "", own: own("rpAssignment") },
    { job: "OOC chat", value: settings.oocAssignment || "", own: own("oocAssignment") },
  ];
  if (settings.summaries === false) {
    jobs.push({ job: "Summaries", value: { none: "Summaries off" }, own: own("summaryAssignment") });
  } else {
    jobs.push({
      job: "Summaries",
      value: settings.summaryAssignment || { same: "Same as roleplay" },
      own: own("summaryAssignment"),
    });
  }
  jobs.push({
    job: "Heartbeat check",
    value: settings.heartbeatAssignment || { none: "No check" },
    own: own("heartbeatAssignment"),
  });
  jobs.push({ job: "Jev", value: { model: settings.decisionModel || "", confidence: settings.decisionConfidence }, own: false });
  jobs.push({ job: "If Jev can't answer", value: settings.decisionFallback || { none: "Nobody" }, own: false });
  for (const channel of channels) {
    if (channel.assignment) jobs.push({ job: `#${channel.name}`, value: channel.assignment, own: false, channel: true });
  }
  return jobs;
}

/** How full a bar is: `value` between `min` and `max`, kept to 0..1. */
function fill(value, min, max) {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** A number as it was typed: no trailing zeros, no float noise (0.9, not 0.90000001). */
export function shortNumber(value) {
  return String(Number(value.toFixed(4)));
}

/**
 * A profile's settings as rows `{ label, value, fill?, note? }`, in the
 * order the profile editor has them. Numbers get a bar (`fill`); "auto"
 * (left to the model) gets none. Reasoning shows only for models that can
 * reason (an unknown model counts as one that can, as in the editor).
 */
export function profileGauges(profile, info = null) {
  const rows = [];
  rows.push({ label: "Temperature", value: shortNumber(profile.temperature), fill: fill(profile.temperature, 0, 2), scale: "0 – 2" });
  const limit = info?.maxOutputTokens ? Math.min(info.maxOutputTokens, 32000) : 32000;
  rows.push({
    label: "Max tokens",
    value: String(profile.maxTokens),
    fill: fill(profile.maxTokens, 0, limit),
    scale: info?.maxOutputTokens ? `of ${limit} (model's limit)` : `of ${limit}`,
  });
  rows.push(
    profile.topP === null
      ? { label: "Top P", value: "auto" }
      : { label: "Top P", value: shortNumber(profile.topP), fill: fill(profile.topP, 0, 1), scale: "0 – 1" },
  );
  rows.push(
    profile.minP === null
      ? { label: "Min P", value: "auto" }
      : { label: "Min P", value: shortNumber(profile.minP), fill: fill(profile.minP, 0, 1), scale: "0 – 1" },
  );
  if (info?.reasoning !== false) {
    rows.push({ label: "Reasoning", value: REASONING[profile.reasoningEffort] ?? "The model's default", steps: reasoningSteps(profile.reasoningEffort) });
  }
  return rows;
}

/** Reasoning as four steps (Off, Low, Medium, High): which one is lit, or -1 for the model's default. */
function reasoningSteps(effort) {
  return ["none", "low", "medium", "high"].indexOf(effort ?? "");
}

/** The on/off switches of a profile, each `{ label, on }`. */
export function profileSwitches(profile) {
  return [
    { label: "Can use tools", on: profile.supportsTools },
    { label: "Consultant", on: profile.consultant },
    { label: "Creates kinwriters", on: profile.kinwriterMaker },
  ];
}

/** A roulette's entries `{ name, weight, share }`, share a whole percent. */
export function rouletteShares(roulette, profiles) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const total = roulette.entries.reduce((sum, e) => sum + e.weight, 0) || 1;
  return roulette.entries.map((e) => ({
    name: byId.get(e.profileId)?.name ?? "?",
    weight: e.weight,
    share: Math.round((e.weight / total) * 100),
  }));
}
