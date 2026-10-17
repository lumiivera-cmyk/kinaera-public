/**
 * What each nanoGPT model supports, so the profile editors show only the
 * settings that apply to it.
 *
 * nanoGPT's model list says, per model, whether it can reason, whether it
 * calls tools natively, and the most tokens it can write. It says nothing
 * about sampling (temperature, Top P, Min P), so those always show. A model
 * the list doesn't know (typed by hand, or the list couldn't load) shows
 * every setting: unknown never reads as "can't".
 *
 * Usage: `loadModelInfo()` fetches the list once (it's also what "Load
 * list" uses), then `modelInfo(id)` returns `{id, reasoning, toolCalling,
 * maxOutputTokens}` (any of the last three may be missing) or null.
 */

import { api, els } from "./core.js";

/** id -> info, once loaded. */
let byId = null;
/** The request in flight, so several editors share one. */
let loading = null;
/** A quiet load failed: don't keep asking until "Load list" is tapped. */
let failed = false;
/** Called after the list arrives, so open editors can redraw. */
const listeners = new Set();

/** The info for one model, or null when it isn't known (yet). */
export function modelInfo(id) {
  return byId?.get((id ?? "").trim()) ?? null;
}

/** Call `listener` each time the list arrives. */
export function onModelInfo(listener) {
  listeners.add(listener);
}

/**
 * Fetch the model list, once. Also fills the model suggestions. With
 * `quiet`, a failure (no API key yet, offline) returns null and later quiet
 * calls don't retry; without it, the failure is thrown. `force` fetches
 * again even if the list is already here.
 */
export async function loadModelInfo({ quiet = true, force = false } = {}) {
  if (!force && (byId || failed)) return byId;
  loading ??= api("GET", "/api/models")
    .then(({ models, info }) => {
      failed = false;
      byId = new Map((info ?? models.map((id) => ({ id }))).map((m) => [m.id, m]));
      els.modelList.replaceChildren(...models.map((id) => new Option(id, id)));
      for (const listener of listeners) listener();
      return byId;
    })
    .catch((error) => {
      failed = true;
      throw error;
    })
    .finally(() => (loading = null));
  try {
    return await loading;
  } catch (error) {
    if (!quiet) throw error;
    return null;
  }
}

/** The highest "Max tokens" this model takes: its own limit, or the app's. */
export function maxTokensFor(id) {
  const limit = modelInfo(id)?.maxOutputTokens;
  return limit ? Math.min(limit, 32000) : 32000;
}

/** A note on tools, when nanoGPT says the model has no native tool calling. */
export function toolNote(id) {
  return modelInfo(id)?.toolCalling === false
    ? "nanoGPT says this model can't call tools natively. It may still manage them as text: Test tools to check."
    : "";
}
