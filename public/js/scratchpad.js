/**
 * A story channel's scratchpads (src/scratchpads.ts): loose notes kept out
 * of the notebook. "Shared" is yours and your kinwriter's, and in their
 * prompt in that channel; "Just mine" is yours alone, never sent to them.
 * They keep a private one too, which you don't see.
 *
 * It works like a shared document. What you type saves itself after a
 * moment (and when you switch pads or close it), and while it's open the
 * pad is checked every few seconds for your kinwriter's changes. Each save
 * sends the text your changes started from, so the server merges yours
 * with any of theirs (`mergeText`): both are kept.
 *
 * Select some text and press "Save to notebook…" to make it a new entry,
 * or add it to one, and (unless you keep it) take it out of the pad.
 */

import { $, api, channelPath, currentChannel, hideFormError, showFormError, state } from "./core.js";
import { refreshNotebook } from "./notebook.js";

/** How long after you stop typing it saves, and how often it looks for their changes. */
const SAVE_AFTER = 1200;
const POLL_EVERY = 4000;

const pads = {
  channelId: null,
  open: "shared",
  data: null,
  /** The text the box's changes started from (what the server had). */
  baseText: "",
  saving: null,
  saveTimer: 0,
  pollTimer: 0,
  /** The selection to save to the notebook: {text, index}. */
  committing: null,
};

const dialog = () => $("scratchpad-dialog");
const box = () => $("scratchpad-text");
const commitDialog = () => $("scratchpad-commit-dialog");
const commitForm = () => $("scratchpad-commit-form");

export async function openScratchpad() {
  const channel = currentChannel();
  if (!channel || channel.kind !== "rp") return;
  pads.channelId = channel.id;
  pads.open = "shared";
  pads.data = null;
  hideFormError(dialog());
  $("scratchpad-channel").textContent = `#${channel.name}`;
  setBox("");
  render();
  dialog().showModal();
  await load();
  clearInterval(pads.pollTimer);
  pads.pollTimer = setInterval(poll, POLL_EVERY);
}

async function load() {
  try {
    pads.data = await api("GET", channelPath("scratchpads", pads.channelId));
    setBox(pads.data[pads.open].text);
    render();
  } catch (error) {
    showFormError(dialog(), error.message);
  }
}

/** Show the server's text, keeping your cursor where it was relative to the text around it. */
function setBox(text) {
  const el = box();
  pads.baseText = text;
  if (el.value === text) return;
  const old = el.value;
  const focused = document.activeElement === el;
  const [start, end] = [el.selectionStart, el.selectionEnd];
  el.value = text;
  if (!focused) return;
  // Text before the cursor that didn't change keeps it in place; otherwise it moves by the change in length.
  let same = 0;
  while (same < old.length && same < text.length && old[same] === text[same]) same++;
  const shift = (i) => (i <= same ? i : Math.max(same, i + text.length - old.length));
  el.setSelectionRange(shift(start), shift(end));
}

/** Whether the box has changes that aren't saved yet. */
const edited = () => box().value.trimEnd() !== pads.baseText;

/** Their changes, while it's open: shown straight away if you aren't mid-change (otherwise the next save merges them in). */
async function poll() {
  if (!dialog().open) return clearInterval(pads.pollTimer);
  if (pads.saving || commitDialog().open) return;
  try {
    const data = await api("GET", channelPath("scratchpads", pads.channelId));
    if (pads.saving || !dialog().open) return;
    pads.data = data;
    if (!edited()) setBox(data[pads.open].text);
    render();
  } catch {
    // Quietly try again next time.
  }
}

/** "5 minutes ago". */
function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function render() {
  const name = state.settings?.friendName ?? "Your kinwriter";
  for (const tab of document.querySelectorAll(".scratchpad-tab")) tab.setAttribute("aria-selected", String(tab.dataset.pad === pads.open));
  $("scratchpad-hint").textContent =
    pads.open === "shared"
      ? `Notes you and ${name} both read and write: details, where everyone is, threads to pick up. It's in their prompt in this channel. Nothing here is lore until it's in the notebook.`
      : `Just yours: ${name} never sees it.${pads.data?.theirs.written ? ` ${name} keeps a private one here too.` : ""}`;
  const pad = pads.data?.[pads.open];
  box().maxLength = pads.data?.limit ?? 12000;
  box().placeholder = pads.open === "shared" ? "Where everyone is, what's been said, what to remember…" : "Secrets, plans, ideas for later…";
  $("scratchpad-status").textContent = !pad
    ? "Loading…"
    : pads.saving
      ? "Saving…"
      : edited()
        ? "Not saved yet…"
        : pad.at
          ? `Saved. Last changed by ${pad.by === "friend" ? name : "you"}, ${ago(pad.at)}.`
          : "Nothing written yet.";
  $("scratchpad-undo").disabled = !pad?.previous;
}

/** Save the open pad if it changed, merged with any changes since. Returns false if it couldn't be saved. */
async function save() {
  clearTimeout(pads.saveTimer);
  if (pads.saving) await pads.saving;
  if (!pads.data || !edited()) return true;
  const which = pads.open;
  const sent = box().value;
  const request = api("PUT", channelPath(`scratchpads/${which}`, pads.channelId), { text: sent, baseText: pads.baseText });
  pads.saving = request;
  render();
  try {
    pads.data = await request;
    hideFormError(dialog());
    // Typed more while it saved: those changes now start from what was sent.
    if (box().value === sent && pads.open === which) setBox(pads.data[which].text);
    else pads.baseText = sent.trimEnd();
    return true;
  } catch (error) {
    showFormError(dialog(), error.message);
    return false;
  } finally {
    pads.saving = null;
    render();
  }
}

function saveSoon() {
  clearTimeout(pads.saveTimer);
  pads.saveTimer = setTimeout(save, SAVE_AFTER);
  render();
}

async function switchTo(name) {
  if (name === pads.open) return;
  if (!(await save())) return;
  pads.open = name;
  setBox(pads.data?.[name].text ?? "");
  render();
}

async function undo() {
  if (!(await save())) return;
  try {
    pads.data = await api("POST", channelPath(`scratchpads/${pads.open}/undo`, pads.channelId), {});
    setBox(pads.data[pads.open].text);
    hideFormError(dialog());
    render();
  } catch (error) {
    showFormError(dialog(), error.message);
  }
}

async function close() {
  if (!(await save())) return;
  clearInterval(pads.pollTimer);
  dialog().close();
}

// ------------------------------------------------------- to the notebook

async function openCommit() {
  const el = box();
  const text = el.value.slice(el.selectionStart, el.selectionEnd);
  if (!text.trim()) return showFormError(dialog(), "Select the text you'd like to save first.");
  const index = el.selectionStart;
  if (!(await save())) return;
  // Saving may have merged in their changes: find the selection again.
  const now = box().value;
  const at = now.slice(index, index + text.length) === text ? index : now.indexOf(text);
  if (at < 0) return showFormError(dialog(), "That text changed as it saved. Select it again.");
  pads.committing = { text, index: at };

  hideFormError(commitForm());
  $("scratchpad-commit-passage").textContent = text.trim();
  commitForm().elements.target.value = "new";
  $("scratchpad-commit-name").value = "";
  $("scratchpad-commit-field").value = "";
  $("scratchpad-commit-keep").checked = false;
  try {
    const { entries } = await api("GET", "/api/notebook");
    const select = $("scratchpad-commit-entry");
    select.replaceChildren(
      ...entries
        .filter((e) => e.access.edit !== "none")
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => Object.assign(document.createElement("option"), { value: e.id, textContent: `${e.name} (${e.kind})${e.access.edit === "suggest" ? ", as a suggestion" : ""}` })),
    );
  } catch (error) {
    showFormError(commitForm(), error.message);
  }
  renderCommit();
  commitDialog().showModal();
}

function renderCommit() {
  const existing = commitForm().elements.target.value === "existing";
  $("scratchpad-commit-new").hidden = existing;
  $("scratchpad-commit-existing").hidden = !existing;
  const kind = existing ? null : $("scratchpad-commit-kind").value;
  $("scratchpad-commit-field").placeholder = kind === "character" ? "Background" : "Details";
}

async function commit(event) {
  event.preventDefault();
  const existing = commitForm().elements.target.value === "existing";
  const body = {
    passage: pads.committing.text,
    index: pads.committing.index,
    field: $("scratchpad-commit-field").value.trim() || undefined,
    keep: $("scratchpad-commit-keep").checked,
    ...(existing
      ? { entryId: $("scratchpad-commit-entry").value }
      : { name: $("scratchpad-commit-name").value.trim(), kind: $("scratchpad-commit-kind").value, pin: $("scratchpad-commit-pin").checked }),
  };
  if (existing && !body.entryId) return showFormError(commitForm(), "There's no entry you can add to yet.");
  try {
    const data = await api("POST", channelPath(`scratchpads/${pads.open}/to-notebook`, pads.channelId), body);
    pads.data = data;
    setBox(data[pads.open].text);
    commitDialog().close();
    const { entry, created, suggested } = data.saved;
    $("scratchpad-status").textContent = suggested
      ? `Suggested adding it to ${entry.name}.`
      : created
        ? `Saved to the notebook as ${entry.name}.`
        : `Added to ${entry.name}.`;
    $("scratchpad-undo").disabled = !data[pads.open].previous;
    refreshNotebook().catch(() => {});
  } catch (error) {
    showFormError(commitForm(), error.message);
  }
}

// --------------------------------------------------------------- wiring

$("scratchpad-button").addEventListener("click", openScratchpad);
for (const tab of document.querySelectorAll(".scratchpad-tab")) tab.addEventListener("click", () => switchTo(tab.dataset.pad));
box().addEventListener("input", saveSoon);
box().addEventListener("blur", () => save());
$("scratchpad-undo").addEventListener("click", undo);
$("scratchpad-commit").addEventListener("click", openCommit);
$("scratchpad-done").addEventListener("click", close);
// Escape closes it too, after saving (or the error says why not, and it stays open).
dialog().addEventListener("cancel", (event) => {
  event.preventDefault();
  close();
});
for (const radio of commitForm().elements.target) radio.addEventListener("change", renderCommit);
$("scratchpad-commit-kind").addEventListener("change", renderCommit);
commitForm().addEventListener("submit", commit);
