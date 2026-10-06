/**
 * A profile's settings, right under the dropdown that chooses it.
 *
 * Wherever you pick a connection profile (who writes roleplay, OOC,
 * summaries, Jev's fallback, a channel, "Regenerate with…", a roulette's
 * entries, the dry run), the chosen profile's settings show below the
 * dropdown and can be changed there: model, temperature, max tokens, top P,
 * min P, reasoning and tools. Each change saves straight away and applies
 * everywhere the profile is used. Its name, model notes and extra request
 * fields are in "All settings…" (the full profile editor).
 *
 * A roulette shows its shares instead, with a button to edit it.
 *
 * Usage: `profileEditor(select, resolve)`, where `resolve(select.value)`
 * returns `{ profile }`, `{ roulette }`, or null (nothing to show, like
 * "Nobody"). Call it again whenever the select's options or value change
 * from code; it redraws (a select's own change event redraws by itself).
 */

import { api, state } from "./core.js";
import { openProfile, openRoulette } from "./settings.js";

/** Every editor on the page, so a saved change shows in all of them. */
const editors = new Set();

/**
 * What an assignment value ("profile:<id>", "roulette:<id>", or "" for
 * the first profile) points at.
 */
export function resolveAssignment(value) {
  const [kind, id] = (value || "").split(":");
  if (kind === "roulette") {
    const roulette = state.roulettes.find((r) => r.id === id);
    return roulette ? { roulette } : null;
  }
  const profile = state.profiles.find((p) => p.id === id) ?? state.profiles[0];
  return profile ? { profile } : null;
}

/** A bare profile id ("" means `fallback`), as "Regenerate with…" and the dry run use. */
export function resolveProfileId(id, fallback = () => null) {
  if (!id) return fallback();
  const profile = state.profiles.find((p) => p.id === id);
  return profile ? { profile } : null;
}

/**
 * Attach (or redraw) the editor under `select`.
 *
 * @param options.collapsed  Start folded (roulette rows, where there are several).
 */
export function profileEditor(select, resolve, options = {}) {
  let editor = select._profileEditor;
  if (!editor) {
    const box = document.createElement("details");
    box.className = "profile-inline";
    box.open = !options.collapsed;
    // In a roulette row, the editor goes under the whole row.
    (select.closest(".roulette-entry") ?? select).after(box);
    editor = { select, box, resolve, render: () => render(editor) };
    select._profileEditor = editor;
    editors.add(editor);
    select.addEventListener("change", editor.render);
  }
  editor.resolve = resolve;
  editor.render();
  return editor;
}

/** Redraw every editor (after profiles were reloaded, say). */
export function refreshProfileEditors() {
  for (const editor of [...editors]) {
    if (!editor.select.isConnected) {
      editors.delete(editor);
      continue;
    }
    // Don't redraw under someone typing.
    if (!editor.box.contains(document.activeElement)) editor.render();
  }
}

function render(editor) {
  const { box, select } = editor;
  const found = editor.resolve(select.value);
  box.hidden = !found;
  if (!found) return box.replaceChildren();
  const summary = document.createElement("summary");

  if (found.roulette) {
    const byId = new Map(state.profiles.map((p) => [p.id, p]));
    const total = found.roulette.entries.reduce((sum, e) => sum + e.weight, 0) || 1;
    summary.textContent = `🎲 ${found.roulette.name}: ${found.roulette.entries
      .map((e) => `${Math.round((e.weight / total) * 100)}% ${byId.get(e.profileId)?.name ?? "?"}`)
      .join(", ") || "empty"}`;
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "A roulette picks one of its profiles each turn. Each profile's settings are in the roulette.";
    const edit = button("Edit roulette…", () => openRoulette(found.roulette));
    box.replaceChildren(summary, hint, edit);
    return;
  }

  const profile = found.profile;
  summary.textContent = `${profile.name}'s settings`;
  const status = document.createElement("span");
  status.className = "hint profile-inline-status";
  status.setAttribute("role", "status");

  const save = async (change) => {
    status.textContent = "Saving…";
    try {
      const { profile: saved } = await api("PATCH", `/api/profiles/${encodeURIComponent(profile.id)}`, change);
      const index = state.profiles.findIndex((p) => p.id === saved.id);
      if (index >= 0) state.profiles[index] = saved;
      status.textContent = "Saved";
      // The others showing this profile catch up (this one keeps its focus).
      for (const other of editors) if (other !== editor && other.select.isConnected) other.render();
    } catch (error) {
      status.textContent = error.message;
    }
  };

  const grid = document.createElement("div");
  grid.className = "grid profile-inline-grid";
  grid.append(
    field("Model", input("text", profile.model, (v) => (v.trim() ? save({ model: v.trim() }) : null), { list: "model-list" }), "profile-inline-model"),
    field("Temperature", input("number", profile.temperature, (v) => save({ temperature: Number(v) }), { min: 0, max: 2, step: 0.05 })),
    field("Max tokens", input("number", profile.maxTokens, (v) => save({ maxTokens: Number(v) }), { min: 16, max: 32000, step: 1 })),
    field("Top P", input("number", profile.topP ?? "", (v) => save({ topP: v === "" ? null : Number(v) }), { min: 0, max: 1, step: 0.01, placeholder: "auto" })),
    field("Min P", input("number", profile.minP ?? "", (v) => save({ minP: v === "" ? null : Number(v) }), { min: 0, max: 1, step: 0.005, placeholder: "auto" })),
    field("Reasoning", reasoningSelect(profile.reasoningEffort, (v) => save({ reasoningEffort: v || null }))),
  );

  const tools = document.createElement("label");
  tools.className = "check-inline";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = profile.supportsTools;
  check.addEventListener("change", () => save({ supportsTools: check.checked }));
  tools.append(check, " Can use tools");

  const row = document.createElement("div");
  row.className = "profile-inline-row";
  row.append(tools, button("All settings…", () => openProfile(profile)), status);
  box.replaceChildren(summary, grid, row);
}

function field(label, control, className = "") {
  const wrap = document.createElement("label");
  wrap.className = `profile-inline-field ${className}`.trim();
  const text = document.createElement("span");
  text.textContent = label;
  wrap.append(text, control);
  return wrap;
}

/** An input that saves on change (not on every keystroke). No `name`: it never joins the form around it. */
function input(type, value, onChange, attributes = {}) {
  const element = document.createElement("input");
  element.type = type;
  element.value = String(value);
  for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, String(val));
  if (type === "text") {
    element.autocomplete = "off";
    element.spellcheck = false;
  }
  element.addEventListener("change", () => {
    if (!element.checkValidity()) return element.reportValidity();
    onChange(element.value);
  });
  // Enter saves this field instead of submitting the dialog around it.
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      element.blur();
    }
  });
  return element;
}

function reasoningSelect(value, onChange) {
  const select = document.createElement("select");
  select.append(
    new Option("Model's default", ""),
    new Option("Low", "low"),
    new Option("Medium", "medium"),
    new Option("High", "high"),
  );
  select.value = value ?? "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function button(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
