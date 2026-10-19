/**
 * The sections of Settings shared by every kinwriter (Models, Memory,
 * Reaching out, Jev, Rules; js/settings-hub.js is the screen) and what hangs
 * off them: profiles and roulettes, their editors, the tool log and tool
 * test, wake-ups and the heartbeat, and Jev's test and log.
 */

import { renderAll } from "./channels.js";
import { $, api, channelPath, els, hideFormError, showFormError, state } from "./core.js";
import { badge, formatTime } from "./format.js";
import { checkLive, loadState } from "./live.js";
import { renderToolCall } from "./messages.js";
import { loadModelInfo, maxTokensFor, modelInfo, onModelInfo, toolNote } from "./model-info.js";
import { loadoutJobs, profileGauges, profileSwitches, rouletteShares, shortNumber } from "./loadout.js";
import { profileEditor, refreshProfileEditors, resolveAssignment } from "./profile-inline.js";
import { explain, saved, sectionShowing, whenSectionShown, whenSettingsOpen } from "./settings-hub.js";
import { renderAppearance } from "./themes.js";

// ---------------------------------------------------------------- dialogs

/**
 * Filling each section of the Settings form from a settings object. The
 * sections are shared by every kinwriter (src/universal.ts); models, memory,
 * reaching out and the look can be set just for one ("Just for …").
 */
const FILL = {
  models(s) {
    const form = els.settingsForm.elements;
    fillAssignmentSelect(form.rpAssignment, s.rpAssignment);
    fillAssignmentSelect(form.oocAssignment, s.oocAssignment);
  },
  memory(s) {
    const form = els.settingsForm.elements;
    form.historyLimit.value = s.historyLimit;
    form.summaries.checked = s.summaries;
    form.summaryEvery.value = s.summaryEvery;
    fillAssignmentSelect(form.summaryAssignment, s.summaryAssignment, "Same as roleplay", () => form.rpAssignment.value);
    // "Same as roleplay" follows the roleplay choice as it changes.
    if (!form.rpAssignment.dataset.followed) {
      form.rpAssignment.dataset.followed = "1";
      form.rpAssignment.addEventListener("change", () => form.summaryAssignment._profileEditor?.render());
    }
    updateSummariesOnly();
  },
  reaching(s) {
    const form = els.settingsForm.elements;
    form.wakeups.value = s.wakeups;
    form.awayHours.value = s.awayHours;
    form.wakeCooldownMinutes.value = s.wakeCooldownMinutes;
    // A value set elsewhere (the API) that isn't one of the choices gets one of its own.
    if (![...form.asideMinutes.options].some((o) => Number(o.value) === s.asideMinutes)) {
      form.asideMinutes.append(new Option(`At most every ${s.asideMinutes} minutes`, String(s.asideMinutes)));
    }
    form.asideMinutes.value = String(s.asideMinutes);
    form.quietStart.value = String(s.quietStart);
    form.quietEnd.value = String(s.quietEnd);
    form.heartbeatHours.value = String(s.heartbeatHours);
    // A custom value (set some other way) still shows.
    if (form.heartbeatHours.value !== String(s.heartbeatHours)) {
      const every = s.heartbeatHours < 1 ? `${Math.round(s.heartbeatHours * 60)} minutes` : `${s.heartbeatHours} hours`;
      form.heartbeatHours.append(new Option(`About every ${every}`, String(s.heartbeatHours)));
      form.heartbeatHours.value = String(s.heartbeatHours);
    }
    fillAssignmentSelect(form.heartbeatAssignment, s.heartbeatAssignment, "No check", () => null);
    updateWakeupsOnly();
  },
  jev(s) {
    const form = els.settingsForm.elements;
    form.decisionModel.value = s.decisionModel;
    form.decisionConfidence.value = s.decisionConfidence;
    fillFallbackSelect(form.decisionFallback, s.decisionFallback);
  },
  limits(s) {
    els.settingsForm.elements.hardLimits.value = s.hardLimits ?? "";
  },
};

/** The "Just for …" boxes: ticked for this kinwriter's own sections. */
function renderOwnBoxes() {
  const own = state.ownSettings ?? [];
  for (const box of els.settingsDialog.querySelectorAll("input[data-own]")) {
    box.checked = own.includes(box.dataset.own);
    box.closest("label").querySelector(".own-name").textContent = state.settings.kinwriterName;
  }
  $("own-status").textContent = "";
}

/** When Settings opens: fill the shared sections from `state.settings`. Every one is saved whole. */
whenSettingsOpen(() => {
  const s = state.settings;
  $("setting-together").checked = state.together === true;
  $("setting-together-status").textContent = "";
  for (const fill of Object.values(FILL)) fill(s);
  renderOwnBoxes();
  $("beat-result").textContent = "";
  $("test-jev-result").textContent = "";
  hideFormError(els.settingsForm);
});
whenSectionShown("reaching", () => {
  renderHeartbeatStatus();
  loadWakeLog();
});
whenSectionShown("models", () => {
  renderModels();
  // What each model supports (its token limit, whether it reasons): the cards redraw when it arrives.
  loadModelInfo();
});

/**
 * "Just for …": a section of Settings just for this kinwriter, or shared
 * again. Saved straight away. Shared again, the section shows everyone's
 * values (the hub sends them back).
 */
for (const box of els.settingsDialog.querySelectorAll("input[data-own]")) {
  box.addEventListener("change", async () => {
    const group = box.dataset.own;
    const status = $("own-status");
    try {
      const data = await api("PUT", `/api/hub/kinwriters/${encodeURIComponent(state.kinwriterId ?? "home")}/own`, { group, own: box.checked });
      state.ownSettings = data.own;
      state.settings = { ...state.settings, ...data.settings };
      // Shared again: everyone's values show (for the look, the whole app redraws).
      if (!box.checked && group === "look") {
        renderAll();
        renderAppearance();
      } else if (!box.checked) FILL[group](state.settings);
      status.textContent = box.checked
        ? `Changes to this section now stay with ${state.settings.kinwriterName}.`
        : `This section is shared again: ${state.settings.kinwriterName} has everyone's.`;
    } catch (error) {
      box.checked = !box.checked;
      status.textContent = error.message;
    }
  });
}

/** The shared settings' fields: a change to any of them saves them all (`saveSettings`). */
const SAVED_FIELDS = new Set([
  "rpAssignment", "oocAssignment", "historyLimit", "hardLimits", "summaries", "summaryEvery", "summaryAssignment",
  "wakeups", "awayHours", "wakeCooldownMinutes", "asideMinutes", "quietStart", "quietEnd", "decisionModel",
  "decisionConfidence", "decisionFallback", "heartbeatHours", "heartbeatAssignment",
]);
/** One save at a time, in order: a quick second change waits for the first. */
let saving = Promise.resolve();

els.settingsForm.addEventListener("change", (event) => {
  if (SAVED_FIELDS.has(event.target.name)) saving = saving.then(saveSettingsNow);
});

/** Enter in a box (the form's submit) saves too; Settings stays open. */
export function saveSettings(event) {
  event.preventDefault();
  saving = saving.then(saveSettingsNow);
}

async function saveSettingsNow() {
  const form = els.settingsForm.elements;
  try {
    const data = await api("PUT", "/api/settings", {
      rpAssignment: form.rpAssignment.value,
      oocAssignment: form.oocAssignment.value,
      // Number boxes give text; the server wants numbers.
      historyLimit: Number(form.historyLimit.value),
      hardLimits: form.hardLimits.value,
      summaries: form.summaries.checked,
      summaryEvery: Number(form.summaryEvery.value),
      summaryAssignment: form.summaryAssignment.value,
      wakeups: form.wakeups.value,
      awayHours: Number(form.awayHours.value),
      wakeCooldownMinutes: Number(form.wakeCooldownMinutes.value),
      asideMinutes: Number(form.asideMinutes.value),
      quietStart: Number(form.quietStart.value),
      quietEnd: Number(form.quietEnd.value),
      decisionModel: form.decisionModel.value,
      decisionConfidence: Number(form.decisionConfidence.value),
      decisionFallback: form.decisionFallback.value,
      heartbeatHours: Number(form.heartbeatHours.value),
      heartbeatAssignment: form.heartbeatAssignment.value,
    });
    state.settings = data.settings;
    hideFormError(els.settingsForm);
    saved();
    renderAll();
  } catch (error) {
    // Put every box back as last saved: the sections are saved whole, so one
    // bad value left in place would stop every later change from saving.
    for (const fill of Object.values(FILL)) fill(state.settings);
    showFormError(els.settingsForm, explain(els.settingsForm, error.message));
  }
}

/** Only profiles (a fallback for Jev can't be a roulette), with "Nobody" first. */
function fillFallbackSelect(select, value) {
  select.replaceChildren(new Option("Nobody", ""), ...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  select.value = value || "";
  if (select.selectedIndex < 0) select.selectedIndex = 0;
  profileEditor(select, (v) => (v ? resolveAssignment(v) : null));
}

/** Show the wake-up settings only while wake-ups are on. */
export function updateWakeupsOnly() {
  const on = els.settingsForm.elements.wakeups.value !== "off";
  for (const element of els.settingsForm.querySelectorAll(".wakeups-only")) element.hidden = !on;
}

const WAKE_REASONS = {
  opened: "You opened the app",
  away: "You came back",
  "scene-ended": "A scene ended",
  review: "A suggestion to review",
  heartbeat: "Heartbeat",
  answer: "You answered an ask",
  orientation: "Orientation",
  scheduled: "A wake-up they set",
  lookback: "The weekly look back",
  aside: "After a story post",
  farewell: "Before archiving",
};
const WAKE_OUTCOMES = { posted: "wrote to you", quiet: "didn't write", failed: "failed" };

/** Whether phone notifications work here, and when the next heartbeat is. */
function renderHeartbeatStatus() {
  const parts = [
    state.notifications
      ? "Phone notifications are on (Termux): you'll get one when your kinwriter writes and the app isn't open."
      : "Phone notifications need Termux:API (on Android); here, messages wait in the app.",
  ];
  if (state.heartbeatNext) parts.push(`Next heartbeat around ${formatTime(state.heartbeatNext)}.`);
  $("heartbeat-status").textContent = parts.join(" ");
}

/** Settings → "Beat now": a heartbeat straight away. */
async function beatNow() {
  const result = $("beat-result");
  const button = $("beat-now");
  button.disabled = true;
  result.textContent = "Beating…";
  try {
    const { beat } = await api("POST", "/api/heartbeat", {});
    result.textContent = beat.detail;
    loadWakeLog();
    checkLive();
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

$("beat-now").addEventListener("click", beatNow);

/** Settings → Reaching out → Recent wake-ups. */
async function loadWakeLog() {
  const list = $("wake-log-list");
  try {
    const { wakeups } = await api("GET", "/api/wakeups");
    if (wakeups.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = "Nothing yet.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...wakeups.map((w) => {
        const item = document.createElement("li");
        item.dataset.outcome = w.outcome;
        const head = document.createElement("strong");
        head.textContent = `${WAKE_REASONS[w.reason] ?? w.reason}: ${WAKE_OUTCOMES[w.outcome] ?? w.outcome}`;
        const time = document.createElement("time");
        time.className = "message-time";
        time.dateTime = w.at;
        time.textContent = ` ${formatTime(w.at)}`;
        const detail = document.createElement("div");
        detail.className = "hint";
        detail.textContent = w.detail;
        item.append(head, time, detail);
        return item;
      }),
    );
  } catch (error) {
    list.replaceChildren();
  }
}

/** Settings → Test Jev: one tiny question, and what came back. */
export async function testJevNow() {
  const result = $("test-jev-result");
  const button = $("test-jev");
  if (button.disabled) return;
  button.disabled = true;
  result.textContent = "Asking Jev…";
  try {
    const data = await api("POST", "/api/jev/test", {});
    const raw = data.report?.raw ? ` Raw reply: ${data.report.raw.slice(0, 300)}` : "";
    result.textContent = `${data.ok ? "✓" : "✗"} ${data.detail}${data.ok ? "" : raw}`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/** Show the summary settings only while summaries are on. */
export function updateSummariesOnly() {
  const on = els.settingsForm.elements.summaries.checked;
  for (const element of els.settingsForm.querySelectorAll(".summaries-only")) element.hidden = !on;
}

// ------------------------------------------------- profiles and roulettes

/*
 * Connection profiles (a model and its settings) and roulettes (a
 * weighted set of profiles). The server keeps them; the app lists, edits
 * and assigns them. An assignment is written "profile:<id>" or
 * "roulette:<id>"; "" means the first profile.
 */

/** Reload profiles and roulettes, and redraw whatever shows them. */
async function refreshProfiles() {
  const { profiles, roulettes } = await api("GET", "/api/profiles");
  state.profiles = profiles;
  state.roulettes = roulettes;
  if (sectionShowing("models")) renderModels();
  // Settings may be open underneath: keep its choices current.
  if (els.settingsDialog.open) {
    const form = els.settingsForm.elements;
    fillAssignmentSelect(form.rpAssignment, form.rpAssignment.value);
    fillAssignmentSelect(form.oocAssignment, form.oocAssignment.value);
    fillAssignmentSelect(form.summaryAssignment, form.summaryAssignment.value, "Same as roleplay", () => form.rpAssignment.value);
    fillAssignmentSelect(form.heartbeatAssignment, form.heartbeatAssignment.value, "No check", () => null);
  }
  refreshProfileEditors();
}

/**
 * Fill a select with every profile and roulette.
 *
 * @param emptyLabel  If given, a first option with value "" and this label
 *                    (e.g. "Same as Settings").
 * @param emptyMeans  For that option: the assignment it stands for, for the
 *                    settings shown under the select (src/profile-inline.js),
 *                    or `null` for none (it means no model at all).
 */
export function fillAssignmentSelect(select, value, emptyLabel, emptyMeans) {
  const profiles = document.createElement("optgroup");
  profiles.label = "Profiles";
  profiles.append(...state.profiles.map((p) => new Option(p.name, `profile:${p.id}`)));
  const roulettes = document.createElement("optgroup");
  roulettes.label = "Roulettes";
  roulettes.append(...state.roulettes.map((r) => new Option(`🎲 ${r.name}`, `roulette:${r.id}`)));
  select.replaceChildren(
    ...(emptyLabel ? [new Option(emptyLabel, "")] : []),
    profiles,
    ...(state.roulettes.length ? [roulettes] : []),
  );
  // "" (no assignment) means the first profile, where there's no "" option.
  select.value = value || (emptyLabel ? "" : `profile:${state.profiles[0]?.id}`);
  if (select.selectedIndex < 0) select.selectedIndex = 0;
  // The chosen profile's settings, editable right here (none when the empty choice means nothing).
  profileEditor(select, (v) => {
    const value = v || (emptyMeans ? emptyMeans() : "");
    return value === null ? null : resolveAssignment(value);
  });
}

/** A readable name for an assignment, e.g. "DeepSeek" or "🎲 Variety". */
export function assignmentName(value) {
  const [kind, id] = (value || "").split(":");
  if (kind === "roulette") return `🎲 ${state.roulettes.find((r) => r.id === id)?.name ?? "?"}`;
  return (state.profiles.find((p) => p.id === id) ?? state.profiles[0])?.name ?? "?";
}

/** Draw the lists of profiles and roulettes, and who writes what. */
function renderModels() {
  const inUse = (value) => {
    const jobs = [];
    if (state.settings.rpAssignment === value) jobs.push("roleplay");
    if (state.settings.oocAssignment === value) jobs.push("OOC");
    if (state.settings.summaryAssignment === value) jobs.push("summaries");
    if (state.settings.heartbeatAssignment === value) jobs.push("the heartbeat check");
    if (state.settings.decisionFallback === value) jobs.push("Jev's fallback");
    const channels = state.channels.filter((c) => c.assignment === value).map((c) => `#${c.name}`);
    return [...jobs, ...channels];
  };

  $("loadout-for").textContent = state.settings.kinwriterName ?? "your kinwriter";
  $("loadout-jobs").replaceChildren(...loadoutJobs(state.settings, state.channels, state.ownSettings ?? []).map(jobRow));

  $("profile-list").replaceChildren(
    ...state.profiles.map((profile, index) => {
      const uses = inUse(`profile:${profile.id}`);
      if (index === 0 && !state.settings.rpAssignment) uses.unshift("roleplay");
      if (index === 0 && !state.settings.oocAssignment) uses.unshift("OOC");
      return profileCard(profile, uses);
    }),
  );

  $("roulette-list").replaceChildren(
    ...state.roulettes.map((roulette) => rouletteCard(roulette, inUse(`roulette:${roulette.id}`))),
  );
}

// The Profiles page redraws once nanoGPT says what each model supports (model limits, reasoning).
onModelInfo(() => {
  if (sectionShowing("models")) renderModels();
});

/** An element with a class and, optionally, text. */
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** One line of "Who writes what": the job, and the profile or roulette doing it. */
function jobRow(job) {
  const row = el("li", "loadout-job");
  const name = el("span", "loadout-job-name", job.job);
  const what = el("span", "loadout-job-what");
  const value = job.value;
  if (typeof value === "string") {
    what.textContent = assignmentName(value);
  } else if (value.same) {
    what.textContent = `${value.same} (${assignmentName(state.settings.rpAssignment)})`;
  } else if ("model" in value) {
    what.textContent = value.model ? `${value.model} · sure at ${value.confidence}` : "Off";
    what.classList.add(value.model ? "loadout-mono" : "loadout-none");
  } else {
    what.textContent = value.none;
    what.classList.add("loadout-none");
  }
  if (job.own) what.append(badge(`just for ${state.settings.kinwriterName}`));
  if (job.channel) what.append(badge("channel's own"));
  row.append(name, what);
  return row;
}

/** A card that opens its editor when tapped (or Enter is pressed on it). */
function card(onOpen) {
  const item = el("li", "profile-row loadout-card");
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.addEventListener("click", onOpen);
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === item) onOpen();
  });
  return item;
}

/** A card header: the name, and badges for what uses it. */
function cardHead(name, uses) {
  const head = el("div", "loadout-card-head");
  head.append(el("span", "profile-row-name", name));
  if (uses.length) {
    const tags = el("span", "notebook-entry-badges");
    tags.append(...uses.map((u) => badge(`used by ${u}`)));
    head.append(tags);
  }
  return head;
}

/** One profile with every setting shown: its model, bars for the numbers, its switches and notes. */
function profileCard(profile, uses) {
  const item = card(() => openProfile(profile));
  const info = modelInfo(profile.model);
  item.append(cardHead(profile.name, uses), el("div", "loadout-model", profile.model));

  const gauges = el("div", "loadout-gauges");
  for (const row of profileGauges(profile, info)) {
    const label = el("span", "loadout-label", row.label);
    let meter;
    if (row.steps !== undefined) {
      meter = el("span", "loadout-steps");
      meter.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 4; i++) meter.append(el("span", i <= row.steps ? "lit" : ""));
    } else if (row.fill !== undefined) {
      meter = el("span", "loadout-bar");
      meter.setAttribute("aria-hidden", "true");
      const bar = el("span");
      bar.style.width = `${Math.round(row.fill * 100)}%`;
      meter.append(bar);
    } else {
      meter = el("span", "loadout-bar loadout-bar-auto");
      meter.setAttribute("aria-hidden", "true");
    }
    const value = el("span", "loadout-value", row.value);
    if (row.scale) value.append(el("span", "loadout-scale", ` ${row.scale}`));
    gauges.append(label, meter, value);
  }
  item.append(gauges);

  const switches = el("div", "loadout-switches");
  for (const s of profileSwitches(profile)) {
    switches.append(el("span", `loadout-switch${s.on ? " on" : ""}`, `${s.on ? "✓" : "✕"} ${s.label}`));
  }
  item.append(switches);
  const note = toolNote(profile.model);
  if (note && profile.supportsTools) item.append(el("p", "hint", note));

  if (profile.quirkPrompt.trim()) {
    item.append(el("div", "loadout-label", "Model notes"), el("div", "loadout-text", profile.quirkPrompt));
  } else {
    const none = el("div", "loadout-label", "Model notes: ");
    none.append(el("span", "loadout-none", "none"));
    item.append(none);
  }
  if (profile.extraParams.trim()) {
    item.append(el("div", "loadout-label", "Extra request fields"), el("div", "loadout-text loadout-mono", profile.extraParams));
  }
  return item;
}

/** One roulette: a bar split by each profile's share, and the weights written out. */
function rouletteCard(roulette, uses) {
  const item = card(() => openRoulette(roulette));
  item.append(cardHead(`🎲 ${roulette.name}`, uses));
  const shares = rouletteShares(roulette, state.profiles);
  if (!shares.length) {
    item.append(el("div", "loadout-none", "Empty"));
    return item;
  }
  const bar = el("div", "loadout-split");
  bar.setAttribute("aria-hidden", "true");
  shares.forEach((share, index) => {
    const part = el("span", "", `${share.share}%`);
    part.style.flexGrow = String(share.weight);
    part.style.setProperty("--part", String(index));
    bar.append(part);
  });
  const list = el("ul", "loadout-shares");
  list.append(...shares.map((s) => el("li", "", `${s.share}% ${s.name} (weight ${shortNumber(s.weight)})`)));
  item.append(bar, list);
  return item;
}

// --------------------------------------------------------- profile editor

/** Open a profile in the editor, or start a new one (`null`). */
export function openProfile(profile) {
  state.editingProfile = profile;
  const form = $("profile-form");
  const f = form.elements;
  hideFormError(form);
  $("profile-title").textContent = profile ? profile.name : "New profile";
  const base = profile ?? state.profiles[0] ?? {};
  f.name.value = profile?.name ?? "";
  f.model.value = profile?.model ?? base.model ?? "";
  f.temperature.value = profile?.temperature ?? 0.9;
  f.maxTokens.value = profile?.maxTokens ?? 1024;
  f.topP.value = profile?.topP ?? "";
  f.minP.value = profile?.minP ?? "";
  f.reasoningEffort.value = profile?.reasoningEffort ?? "";
  f.supportsTools.checked = profile?.supportsTools ?? true;
  f.consultant.checked = profile?.consultant ?? false;
  f.kinwriterMaker.checked = profile?.kinwriterMaker ?? false;
  f.quirkPrompt.value = profile?.quirkPrompt ?? "";
  f.extraParams.value = profile?.extraParams ?? "";
  form.querySelector(".advanced").open = Boolean(profile?.extraParams);
  $("profile-delete").hidden = !profile;
  renderToolTest(profile);
  showModelSettings();
  loadModelInfo();
  $("profile-dialog").showModal();
}

/**
 * Show only the settings the chosen model supports (src/nanogpt.ts
 * `listModels`): no Reasoning for a model that can't reason, Max tokens
 * capped at the model's own limit, and a note when it can't call tools.
 */
function showModelSettings() {
  const f = $("profile-form").elements;
  const model = f.model.value;
  const reasons = modelInfo(model)?.reasoning !== false;
  $("profile-reasoning-field").hidden = !reasons;
  f.maxTokens.max = String(maxTokensFor(model));
  const note = $("profile-tools-note");
  note.textContent = toolNote(model);
  note.hidden = !note.textContent;
}

const profileModel = $("profile-form").elements.model;
profileModel.addEventListener("input", showModelSettings);
profileModel.addEventListener("change", showModelSettings);
onModelInfo(() => {
  if ($("profile-dialog").open) showModelSettings();
});

export async function saveProfile(event) {
  event.preventDefault();
  const form = $("profile-form");
  const f = form.elements;
  const body = {
    name: f.name.value,
    model: f.model.value,
    // Number boxes give text; the server wants numbers.
    temperature: Number(f.temperature.value),
    maxTokens: Number(f.maxTokens.value),
    topP: f.topP.value === "" ? null : Number(f.topP.value),
    minP: f.minP.value === "" ? null : Number(f.minP.value),
    // A model that can't reason has no Reasoning setting to send.
    reasoningEffort: modelInfo(f.model.value)?.reasoning === false ? null : f.reasoningEffort.value || null,
    supportsTools: f.supportsTools.checked,
    consultant: f.consultant.checked,
    kinwriterMaker: f.kinwriterMaker.checked,
    quirkPrompt: f.quirkPrompt.value,
    extraParams: f.extraParams.value,
  };
  try {
    const profile = state.editingProfile;
    if (profile) await api("PATCH", `/api/profiles/${encodeURIComponent(profile.id)}`, body);
    else await api("POST", "/api/profiles", body);
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

export async function deleteProfile() {
  const profile = state.editingProfile;
  if (!confirm(`Delete the profile "${profile.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/profiles/${encodeURIComponent(profile.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("profile-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("profile-form"), error.message);
  }
}

/** Ask the server which models nanoGPT offers and offer them as suggestions. */
export async function loadModels() {
  els.loadModels.disabled = true;
  els.loadModels.textContent = "Loading…";
  try {
    const models = await loadModelInfo({ quiet: false, force: true });
    els.loadModels.textContent = `${models.size} models`;
    // Focus the model box so the suggestions are one tap away.
    $("profile-form").elements.model.focus();
  } catch (error) {
    showFormError($("profile-form"), error.message);
    els.loadModels.textContent = "Load list";
  } finally {
    els.loadModels.disabled = false;
  }
}

// -------------------------------------------------------- roulette editor

export function openRoulette(roulette) {
  state.editingRoulette = roulette;
  const form = $("roulette-form");
  hideFormError(form);
  $("roulette-title").textContent = roulette ? `🎲 ${roulette.name}` : "New roulette";
  form.elements.name.value = roulette?.name ?? "";
  const entries = roulette?.entries ?? state.profiles.slice(0, 2).map((p) => ({ profileId: p.id, weight: 1 }));
  $("roulette-entries").replaceChildren(...entries.map(rouletteEntryRow));
  updateRouletteShares();
  $("roulette-delete").hidden = !roulette;
  $("roulette-dialog").showModal();
}

/** One row of the roulette editor: a profile, its weight, its share, and a remove button. */
export function rouletteEntryRow(entry) {
  const row = document.createElement("div");
  row.className = "roulette-entry";
  const select = document.createElement("select");
  select.className = "roulette-profile";
  select.setAttribute("aria-label", "Profile");
  select.append(...state.profiles.map((p) => new Option(p.name, p.id)));
  select.value = entry.profileId;
  const weight = document.createElement("input");
  weight.className = "roulette-weight";
  weight.type = "number";
  weight.min = "0.01";
  weight.step = "any";
  weight.value = entry.weight;
  weight.setAttribute("aria-label", "Weight");
  const share = document.createElement("span");
  share.className = "roulette-share";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button";
  remove.textContent = "✕";
  remove.setAttribute("aria-label", "Remove");
  remove.addEventListener("click", () => {
    select._profileEditor?.box.remove();
    row.remove();
    updateRouletteShares();
  });
  row.append(select, weight, share, remove);
  // Its settings, folded (a roulette has several), once the row is on the page.
  queueMicrotask(() => {
    if (row.isConnected) profileEditor(select, (id) => resolveAssignment(`profile:${id}`), { collapsed: true });
  });
  return row;
}

/** Show each row's chance, e.g. "40%". */
export function updateRouletteShares() {
  const rows = [...$("roulette-entries").querySelectorAll(".roulette-entry")];
  const weights = rows.map((row) => Math.max(0, Number(row.querySelector(".roulette-weight").value) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  rows.forEach((row, i) => {
    row.querySelector(".roulette-share").textContent = total ? `${Math.round((weights[i] / total) * 100)}%` : "";
  });
}

export async function saveRoulette(event) {
  event.preventDefault();
  const form = $("roulette-form");
  const entries = [...$("roulette-entries").querySelectorAll(".roulette-entry")].map((row) => ({
    profileId: row.querySelector(".roulette-profile").value,
    weight: Number(row.querySelector(".roulette-weight").value),
  }));
  try {
    const roulette = state.editingRoulette;
    const body = { name: form.elements.name.value, entries };
    if (roulette) await api("PATCH", `/api/roulettes/${encodeURIComponent(roulette.id)}`, body);
    else await api("POST", "/api/roulettes", body);
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError(form, error.message);
  }
}

export async function deleteRoulette() {
  const roulette = state.editingRoulette;
  if (!confirm(`Delete the roulette "${roulette.name}"? Anything using it goes back to the default.`)) return;
  try {
    const { settings, channels } = await api("DELETE", `/api/roulettes/${encodeURIComponent(roulette.id)}`, {});
    state.settings = settings;
    state.channels = channels;
    $("roulette-dialog").close();
    await refreshProfiles();
  } catch (error) {
    showFormError($("roulette-form"), error.message);
  }
}

// ---------------------------------------------------------------- tool log

export async function openToolLog() {
  $("tool-log-copy").textContent = "Copy as text";
  try {
    const { toolCalls } = await api("GET", channelPath("tool-log"));
    state.toolLog = toolCalls;
    renderToolLog();
    $("tool-log-dialog").showModal();
  } catch (error) {
    showFormError(els.channelForm, error.message);
  }
}

export function renderToolLog() {
  const errorsOnly = $("tool-log-errors").checked;
  const calls = [...state.toolLog].reverse().filter((c) => !errorsOnly || c.status === "error");
  const list = $("tool-log-list");
  if (calls.length === 0) {
    const empty = document.createElement("li");
    empty.className = "hint";
    empty.textContent = errorsOnly ? "No errors." : `${state.settings.kinwriterName} hasn't used any tools here yet.`;
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...calls.map(renderToolCall));
}

/** Copy the tool log as plain text, e.g. to share when something goes wrong. */
export async function copyToolLog() {
  const text = state.toolLog
    .map((c) =>
      [
        `${c.createdAt}  ${c.profile ?? ""}  round ${c.round + 1}  ${c.source}  ${c.status}`,
        `${c.name} ${c.arguments}`,
        `-> ${c.result}`,
      ].join("\n"),
    )
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(text);
    $("tool-log-copy").textContent = "Copied";
  } catch {
    showFormError($("tool-log-dialog"), "Couldn't copy: your browser didn't allow it.");
  }
}

// ------------------------------------------------------------- tool test

/** Under "Test tools" in the profile editor: the last result, or a hint. */
function renderToolTest(profile, result) {
  const box = $("profile-test-result");
  $("profile-test").disabled = !profile;
  box.dataset.verdict = result?.verdict ?? "";
  if (!profile) {
    box.textContent = "Save the profile first, then test it.";
  } else if (!result) {
    box.textContent = "Checks whether this model can call tools, with one small request.";
  } else {
    const labels = { native: "✓ Works", text: "~ Works, as text", none: "✗ No tool call", broken: "✗ Broken arguments" };
    box.textContent = `${labels[result.verdict]} (${result.seconds}s). ${result.detail}`;
  }
}

export async function testProfileTools() {
  const profile = state.editingProfile;
  const button = $("profile-test");
  button.disabled = true;
  button.textContent = "Testing…";
  try {
    const { test } = await api("POST", `/api/profiles/${encodeURIComponent(profile.id)}/test`, {});
    renderToolTest(profile, test);
  } catch (error) {
    showFormError($("profile-form"), error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Test tools";
  }
}

// ------------------------------------------------------- kinwriters together

/** Settings → Labs → Kinwriters together: hub-wide, saved straight away. */
$("setting-together").addEventListener("change", async (event) => {
  const status = $("setting-together-status");
  try {
    const data = await api("PATCH", "/api/hub/options", { together: event.target.checked });
    state.hub = data.servers;
    state.together = data.together;
    status.textContent = data.together ? "On. Group channels and DMs are back." : "Off. Each kinwriter is on their own.";
    // The channel list changes with it (group channels and DMs come and go).
    await loadState();
    renderAll();
  } catch (error) {
    event.target.checked = !event.target.checked;
    status.textContent = error.message;
  }
});
