/**
 * The tool map: a kinwriter's own "I'd reach for this when…" line for each
 * tool, written as they try them (the orientation's lessons ask for one
 * per tool, and they can write or change one any time).
 *
 * One line per tool. It's theirs: the user reads it on their page, and
 * their prompt carries each line right next to that tool's description, so
 * it's in front of them at the moment they decide.
 */

import type { Store } from "./store.ts";

const KEY = "toolmap";
export const MAP_LINE_LIMIT = 300;

export interface MapEntry {
  when: string;
  at: string;
}

export function toolMap(store: Store): Record<string, MapEntry> {
  const value = store.appState.get(KEY);
  return value ? (JSON.parse(value) as Record<string, MapEntry>) : {};
}

/** Write (or, with an empty line, remove) their entry for a tool. */
export function setMapEntry(store: Store, tool: string, when: string): void {
  const map = toolMap(store);
  const line = when.trim().replace(/\s+/g, " ");
  if (line.length > MAP_LINE_LIMIT) throw new Error(`Keep it to one line (${MAP_LINE_LIMIT} characters at most).`);
  if (line) map[tool] = { when: line, at: new Date().toISOString() };
  else delete map[tool];
  store.appState.set(KEY, JSON.stringify(map));
}
