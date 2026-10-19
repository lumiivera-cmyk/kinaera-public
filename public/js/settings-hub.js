/**
 * Settings: one screen, with a list of sections down the side (on a phone,
 * the list first, then a section with a back arrow). Each section is a
 * `.settings-panel` in index.html, grouped by who it's for: every kinwriter,
 * this kinwriter, this server, and the app.
 *
 * The modules that own the sections register what to do when Settings opens
 * (fill their forms: a section saves all its fields, so they must be
 * current) and when their section is shown (load what's slow to load).
 * Changes save as they're made, so there's no Save button; `saved()` shows a
 * short "Saved" in the header.
 */

import { $, els, readLocal, state, writeLocal } from "./core.js";

const dialog = els.settingsDialog;
const panels = [...dialog.querySelectorAll(".settings-panel")];
const items = [...dialog.querySelectorAll(".settings-nav-item")];
/** Wide enough for the list and a section side by side (as the sidebar, style.css). */
const wide = matchMedia("(min-width: 800px)");
const LAST_KEY = "kinaera.settings.section";

const openHooks = [];
const showHooks = new Map();
let current = null;
let savedTimer = 0;

/** Who each section is for, under its title. */
const FOR = {
  models: () => `Shared by every kinwriter, unless "Just for" is ticked.`,
  memory: () => `Shared by every kinwriter, unless "Just for" is ticked.`,
  reaching: () => `Shared by every kinwriter, unless "Just for" is ticked.`,
  jev: () => "Shared by every kinwriter.",
  prompts: () => "Shared by every kinwriter.",
  rules: () => "Shared by every kinwriter.",
  look: () => `Shared by every kinwriter, unless "Just for" is ticked. Glass effects and folding are for this device only.`,
  profile: () => `Just for ${state.settings.kinwriterName}.`,
  writing: () => `Just for ${state.settings.kinwriterName}.`,
  behaving: () => `Just for ${state.settings.kinwriterName}.`,
  servers: () => "For this server.",
  emojis: () => "For every kinwriter.",
  labs: () => "For every kinwriter, on every server.",
  setup: () => "For the whole app.",
  developer: () => `For ${state.settings.kinwriterName}.`,
};

/** Run when Settings opens, before any section shows. */
export function whenSettingsOpen(fn) {
  openHooks.push(fn);
}

/** Run each time `section` is shown. */
export function whenSectionShown(section, fn) {
  if (!showHooks.has(section)) showHooks.set(section, []);
  showHooks.get(section).push(fn);
}

/** Whether Settings is open on `section`. */
export function sectionShowing(section) {
  return dialog.open && current === section;
}

/**
 * Open Settings, on `section` if given. Without one: on a phone, the list of
 * sections; wider, the section you had open last.
 */
export function openSettings(section) {
  for (const fn of openHooks) run(fn);
  for (const name of dialog.querySelectorAll(".settings-nav .own-name")) name.textContent = state.settings.kinwriterName;
  dialog.querySelector('.settings-nav-item[data-section="developer"]').hidden = !state.developerPanel;
  $("settings-saved").textContent = "";
  if (!dialog.open) dialog.showModal();
  let wanted = typeof section === "string" ? section : wide.matches ? readLocal(LAST_KEY) || "models" : null;
  // Last time on Developer, but the developer panel has been turned off since.
  if (wanted === "developer" && !state.developerPanel) wanted = "models";
  if (wanted && panels.some((p) => p.dataset.section === wanted)) showSection(wanted);
  else showList();
  // Focus the close button that's showing, not the first thing that scrolls (a ring round the list).
  const close = dialog.querySelector(dialog.dataset.view === "panel" ? ".settings-head .settings-close" : ".settings-nav .settings-close");
  close.focus({ preventScroll: true });
}

/** Show one section (its panel), and say who it's for. */
export function showSection(section) {
  current = section;
  for (const panel of panels) panel.hidden = panel.dataset.section !== section;
  for (const item of items) item.setAttribute("aria-current", String(item.dataset.section === section));
  const panel = panels.find((p) => p.dataset.section === section);
  $("settings-title").textContent = panel?.dataset.title ?? "";
  $("settings-for").textContent = FOR[section]?.() ?? "";
  $("own-status").textContent = "";
  // A failed save puts its boxes back as they were (see `explain`), so its message can go.
  for (const error of dialog.querySelectorAll(".form-error")) error.hidden = true;
  dialog.dataset.view = "panel";
  $("settings-scroll").scrollTop = 0;
  writeLocal(LAST_KEY, section);
  for (const fn of showHooks.get(section) ?? []) run(fn);
}

/** On a phone: back to the list of sections. */
function showList() {
  dialog.dataset.view = "list";
  // Wider, a section always shows beside the list.
  if (wide.matches) showSection(current ?? "models");
}

/**
 * Why a save failed, in the box's own words: the server names a setting by
 * its key ("historyLimit must be between 1 and 1000"), so the key becomes
 * the label you see ("Recent messages" must be between 1 and 1000).
 * `aliases` maps a key to the box's name where they differ.
 */
export function explain(form, message, aliases = {}) {
  let box = null;
  let text = message.replace(/^(\w+)/, (key) => {
    const field = form.elements[aliases[key] ?? key];
    box = field instanceof RadioNodeList ? field[0] : field;
    const label = box?.labels?.[0] ?? box?.closest?.("label");
    const name = (label?.querySelector("strong") ?? label)?.textContent.trim();
    return name ? `"${name}"` : key;
  });
  // The box's own range, in its own units (a pause in seconds, not the milliseconds it's kept in).
  if (box?.min && box?.max) text = text.replace(/must be between \S+ and \S+/, `must be between ${box.min} and ${box.max}`);
  text = text.replace("must be non-empty text", "can't be empty");
  return `${text.replace(/\.$/, "")}. It's back as it was.`;
}

/** A quiet "Saved" in the header, for a moment. */
export function saved(text = "Saved") {
  const box = $("settings-saved");
  box.textContent = `✓ ${text}`;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (box.textContent = ""), 2500);
}

function run(fn) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}

for (const item of items) item.addEventListener("click", () => showSection(item.dataset.section));
$("settings-back").addEventListener("click", showList);
// Turned to wide with the list showing: show a section beside it.
wide.addEventListener("change", () => dialog.open && wide.matches && !current && showSection("models"));
