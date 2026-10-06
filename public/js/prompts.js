/**
 * The Prompts screen (Settings → Prompts and dry run…).
 *
 *   - **Wording**: every section of every file in `defaults/`, for every
 *     kinwriter. Edit one and Save; Reset brings back the default. Your edits
 *     are kept in the data folder (`prompts.json`), apart from the defaults.
 *   - **Dry run**: any kind of turn's prompt, built as that turn would
 *     build it, and optionally the model's answer to it. Nothing is saved
 *     and no tool runs (src/kinwriter.ts, `Kinwriter.dryRun`).
 *
 * The server never sends journal text, draft titles or notes on other
 * kinwriters to this screen: they show as "(private)", like Preview prompt.
 */

import { $, api, els, hideFormError, showFormError, state } from "./core.js";
import { openKinwriter } from "./kinwriter-page.js";
import { profileEditor, resolveAssignment, resolveProfileId } from "./profile-inline.js";

const dialog = $("prompts-dialog");
const filesBox = $("prompts-files");
const search = $("prompts-search");
const dryForm = $("dry-run-form");
const result = $("dry-run-result");

/** The files as the server last sent them. */
let files = [];
/** Which files are open, kept across a re-draw. */
const openFiles = new Set();
/** Sections saved or reset during this search: they stay shown even if they no longer match. */
const touched = new Set();

/** Open the screen, on the Wording tab or the Dry run tab. */
export async function openPrompts(tab = "wording") {
  showTab(tab);
  fillDryRunChoices();
  if (!dialog.open) dialog.showModal();
  try {
    files = (await api("GET", "/api/hub/prompts")).files;
    renderFiles();
  } catch (error) {
    filesBox.textContent = error.message;
  }
}

function showTab(tab) {
  for (const button of dialog.querySelectorAll(".prompts-tab")) button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  for (const panel of dialog.querySelectorAll(".prompts-panel")) panel.hidden = panel.dataset.panel !== tab;
}

// ------------------------------------------------------------- wording

/** "time" → "Time", "ooc" → "OOC". */
function fileTitle(file) {
  if (file === "ooc") return "OOC";
  return file.charAt(0).toUpperCase() + file.slice(1);
}

function renderFiles() {
  const query = search.value.trim().toLowerCase();
  const matches = (file, section) =>
    !query || touched.has(`${file.file}/${section.name}`) || section.name.toLowerCase().includes(query) || section.text.toLowerCase().includes(query) || file.file.includes(query);
  filesBox.replaceChildren(
    ...files
      .map((file) => {
        const sections = file.sections.filter((s) => matches(file, s));
        if (sections.length === 0) return null;
        const details = document.createElement("details");
        details.className = "prompts-file";
        details.open = Boolean(query) || openFiles.has(file.file);
        details.addEventListener("toggle", () => (details.open ? openFiles.add(file.file) : openFiles.delete(file.file)));
        const summary = document.createElement("summary");
        const edited = file.sections.filter((s) => s.edited).length;
        summary.textContent = fileTitle(file.file);
        if (edited) summary.append(chip(`${edited} edited`));
        const about = document.createElement("p");
        about.className = "hint";
        about.textContent = `defaults/${file.file}.md. ${file.about.replace(/\s*\n\s*/g, " ")}`;
        details.append(summary, about, ...sections.map((section) => renderSection(file, section)));
        return details;
      })
      .filter(Boolean),
  );
  if (!filesBox.childElementCount) filesBox.textContent = "Nothing matches.";
}

function chip(text) {
  const span = document.createElement("span");
  span.className = "prompts-chip";
  span.textContent = text;
  return span;
}

function renderSection(file, section) {
  const box = document.createElement("div");
  box.className = "prompts-section";
  const head = document.createElement("div");
  head.className = "prompts-section-head";
  const name = document.createElement("code");
  name.textContent = section.name;
  head.append(name);
  if (section.edited) head.append(chip("edited"));

  const text = document.createElement("textarea");
  text.value = section.text;
  text.rows = Math.min(14, Math.max(2, Math.ceil(section.text.length / 60) + section.text.split("\n").length - 1));
  text.setAttribute("aria-label", `${file.file}: ${section.name}`);

  const buttons = document.createElement("div");
  buttons.className = "memory-buttons";
  const save = button("Save", "button button-primary");
  const reset = button("Reset to default", "button");
  save.disabled = true;
  reset.disabled = !section.edited;
  text.addEventListener("input", () => (save.disabled = text.value === section.text));
  const status = document.createElement("span");
  status.className = "hint";
  status.setAttribute("role", "status");
  const send = async (method, body, done) => {
    try {
      files = (await api(method, `/api/hub/prompts/${encodeURIComponent(file.file)}/${encodeURIComponent(section.name)}`, body)).files;
      openFiles.add(file.file);
      touched.add(`${file.file}/${section.name}`);
      renderFiles();
      flash(file.file, section.name, done);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  save.addEventListener("click", () => send("PUT", { text: text.value }, "Saved. It's used from the next turn on."));
  reset.addEventListener("click", () => {
    if (confirm(`Put "${section.name}" back to its default wording?`)) send("DELETE", undefined, "Back to the default.");
  });
  buttons.append(save, reset, status);
  box.append(head, text, buttons);
  box.dataset.key = `${file.file}/${section.name}`;
  return box;
}

/** Say what happened, on the section that was just saved or reset. */
function flash(file, name, message) {
  const box = filesBox.querySelector(`[data-key="${CSS.escape(`${file}/${name}`)}"]`);
  const status = box?.querySelector("[role=status]");
  if (status) status.textContent = message;
}

function button(text, className) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  return b;
}

// ------------------------------------------------------------- dry run

function fillDryRunChoices() {
  const channels = dryForm.elements.channelId;
  const chosen = channels.value || state.channelId;
  channels.replaceChildren(
    ...state.channels.map((c) => new Option(`#${c.name}`, c.id)),
  );
  if (state.channels.some((c) => c.id === chosen)) channels.value = chosen;
  const profiles = dryForm.elements.profileId;
  const profile = profiles.value;
  profiles.replaceChildren(
    new Option("Whoever usually writes there", ""),
    ...state.profiles.map((p) => new Option(`${p.name} (${p.model})${p.supportsTools ? "" : ", no tools"}`, p.id)),
  );
  profiles.value = state.profiles.some((p) => p.id === profile) ? profile : "";
  updateTurnKind();
  // The profile's settings, editable here: try a change, then build or ask again.
  profileEditor(profiles, (id) => resolveProfileId(id, () => resolveAssignment(usualAssignment())));
}

/** What usually writes in the channel the dry run is for (practice for turns of their own). */
function usualAssignment() {
  const own = ["orientation", "lookback"].includes(dryForm.elements.turn.value);
  const channel = own ? state.practice : state.channels.find((c) => c.id === dryForm.elements.channelId.value);
  if (channel?.assignment) return channel.assignment;
  return channel?.kind === "rp" ? state.settings.rpAssignment : state.settings.oocAssignment;
}

/**
 * Orientation and the look back always happen in the practice channel.
 * Other wake-ups happen in OOC (a scheduled one wherever they set it), so
 * choosing one moves the channel there; you can still pick another.
 */
function updateTurnKind(event) {
  const turn = dryForm.elements.turn.value;
  dryForm.elements.channelId.disabled = ["orientation", "lookback"].includes(turn);
  const ooc = state.channels.find((c) => c.kind === "ooc");
  if (event && ooc && !["turn", "scheduled", "orientation", "lookback"].includes(turn)) dryForm.elements.channelId.value = ooc.id;
  if (event) dryForm.elements.profileId._profileEditor?.render();
}

async function runDry(event) {
  event.preventDefault();
  hideFormError(dryForm);
  const send = event.submitter?.value === "send";
  const buttons = dryForm.querySelectorAll("button");
  for (const b of buttons) b.disabled = true;
  result.textContent = send ? "Asking the model…" : "Building…";
  try {
    const data = await api("POST", "/api/dry-run", {
      turn: dryForm.elements.turn.value,
      channelId: dryForm.elements.channelId.value,
      profileId: dryForm.elements.profileId.value,
      send,
    });
    renderResult(data);
  } catch (error) {
    result.textContent = "";
    showFormError(dryForm, error.message);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function renderResult(data) {
  const parts = [];
  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = `#${data.channel.name}, written by ${data.profile.name} (${data.profile.model}). ${
    data.profile.supportsTools ? `${data.tools.length} tools offered.` : "This profile can't use tools."
  }`;
  parts.push(head);

  if (data.reply) {
    parts.push(block("What they'd write", data.reply.content || "(nothing: no text)"));
    if (data.reply.toolCalls.length) {
      parts.push(
        block(
          "Tools they'd call (not run)",
          data.reply.toolCalls.map((c) => `${c.name} ${c.arguments}`).join("\n"),
        ),
      );
    }
  }

  // The system prompt, one fold per section (its "## " headings).
  const [system, ...rest] = data.messages;
  if (system?.role === "system") {
    const sections = system.content.split(/^## /m).filter((s) => s.trim());
    const all = fold(`System prompt (${sections.length} sections, ${system.content.length.toLocaleString()} characters)`, true);
    for (const section of sections) {
      const [title, ...body] = section.split("\n");
      const inner = fold(title.trim());
      inner.append(pre(body.join("\n").trim()));
      all.append(inner);
    }
    parts.push(all);
  }
  const conversation = fold(`Conversation (${rest.length} message${rest.length === 1 ? "" : "s"})`);
  for (const message of rest) conversation.append(block(message.role, message.content));
  parts.push(conversation);

  if (data.tools.length) {
    const tools = fold(`Tools offered (${data.tools.length})`);
    for (const tool of data.tools) tools.append(block(tool.private ? `${tool.name} (private)` : tool.name, tool.description));
    parts.push(tools);
  }
  result.replaceChildren(...parts);
}

function fold(title, open = false) {
  const details = document.createElement("details");
  details.className = "prompts-fold";
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.append(summary);
  return details;
}

function pre(text) {
  const p = document.createElement("pre");
  p.textContent = text;
  return p;
}

/** A labelled block, like Preview prompt's. */
function block(label, text) {
  const box = document.createElement("div");
  box.className = "prompt-message";
  const role = document.createElement("div");
  role.className = "prompt-role";
  role.textContent = label;
  box.append(role, pre(text));
  return box;
}

// -------------------------------------------------------------- wiring

for (const tab of dialog.querySelectorAll(".prompts-tab")) tab.addEventListener("click", () => showTab(tab.dataset.tab));
search.addEventListener("input", () => {
  touched.clear();
  renderFiles();
});
dryForm.addEventListener("submit", runDry);
dryForm.elements.turn.addEventListener("change", updateTurnKind);
dryForm.elements.channelId.addEventListener("change", () => dryForm.elements.profileId._profileEditor?.render());
$("open-prompts").addEventListener("click", () => {
  els.settingsDialog.close();
  openPrompts();
});
$("prompts-open-friend").addEventListener("click", () => {
  dialog.close();
  openKinwriter();
});
