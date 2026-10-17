/**
 * Reading bookmarks: where your kinwriter got to in each library document
 * (src/library.ts), so a long read can carry on across turns. A turn has
 * only so many tool rounds, and the next one starts fresh: without this,
 * all they had was a line in "What you did recently".
 *
 * `read_library` moves the bookmark forward (never back: rereading an
 * earlier passage doesn't lose their place), and their prompt's library
 * section says "you've read up to passage 7 of 67" beside the document.
 */

import type { Database } from "bun:sqlite";
import { AppState } from "./appstate.ts";
import type { Store } from "./store.ts";

const KEY = "library.read";

export interface Bookmark {
  /** The furthest passage they've read. */
  to: number;
  at: string;
}

export function bookmarks(store: Store): Record<string, Bookmark> {
  const value = store.appState.get(KEY);
  return value ? (JSON.parse(value) as Record<string, Bookmark>) : {};
}

/** They read up to `passage` of a document: move the bookmark there if it's further. */
export function markRead(store: Store, docId: string, passage: number): Bookmark {
  const all = bookmarks(store);
  const mark = { to: Math.max(passage, all[docId]?.to ?? 0), at: new Date().toISOString() };
  all[docId] = mark;
  store.appState.set(KEY, JSON.stringify(all));
  return mark;
}

/** Forget the bookmark in a document that's being deleted (src/library.ts). */
export function forgetBookmark(db: Database, docId: string): void {
  const state = new AppState(db);
  const value = state.get(KEY);
  if (!value) return;
  const all = JSON.parse(value) as Record<string, Bookmark>;
  if (!(docId in all)) return;
  delete all[docId];
  state.set(KEY, Object.keys(all).length ? JSON.stringify(all) : null);
}
