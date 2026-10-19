/**
 * Settings → API key and setup: your `.env` file, a field per setting
 * (src/envfile.ts). Saved changes are used after a restart (Ctrl-C in
 * Termux, then `bun start`), and the screen says so until then.
 *
 * The API key is never sent here: only whether one is set, and its last
 * four characters. Its field starts empty; typing a key replaces it.
 */

import { $, api, hideFormError, showFormError } from "./core.js";
import { whenSectionShown } from "./settings-hub.js";

const form = $("server-setup-form");
const FIELDS = ["HOST", "PORT", "ALLOWED_HOSTS", "REQUEST_TIMEOUT_SECONDS"];

whenSectionShown("setup", async () => {
  hideFormError(form);
  form.reset();
  try {
    show(await api("GET", "/api/hub/env"));
  } catch (error) {
    showFormError(form, error.message);
  }
});

function show(view) {
  for (const name of FIELDS) form.elements[name].value = view.values[name];
  form.elements.DEVELOPER_PANEL.checked = view.values.DEVELOPER_PANEL === "1";
  form.elements.apiKey.value = "";
  const { set, ending } = view.apiKey;
  form.elements.apiKey.placeholder = set ? "Set. Paste a new key to replace it." : "Not set yet. Paste your key here.";
  $("server-setup-key-status").textContent = set
    ? ending
      ? `A key ending in …${ending} is saved.`
      : "A key is saved."
    : "From nano-gpt.com, under API settings. Your kinwriters can't write without it.";
  $("server-setup-restart").hidden = !view.restartNeeded;
  $("server-setup-saved").textContent = "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideFormError(form);
  const values = Object.fromEntries(FIELDS.map((name) => [name, form.elements[name].value]));
  values.DEVELOPER_PANEL = form.elements.DEVELOPER_PANEL.checked ? "1" : "";
  try {
    const view = await api("PUT", "/api/hub/env", { values, apiKey: form.elements.apiKey.value });
    show(view);
    if (!view.restartNeeded) $("server-setup-saved").textContent = "Saved. The server is already using these, so there's no need to restart.";
  } catch (error) {
    showFormError(form, error.message);
  }
});

