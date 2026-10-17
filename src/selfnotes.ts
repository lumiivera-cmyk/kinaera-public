/**
 * Self-notes: who your kinwriter is, in their own words (`self.md` in
 * design/kinwriter-generation/spec.md). They're the identity of
 * src/identity.ts (who they are, and their tastes), not a second store:
 * this file only adds what the spec asks on top of it.
 *
 *   - **Private by default.** You can't read them unless they share them.
 *     You ask (`request`); they see your request on their next turn and
 *     decide (`answer`, the `share_self_notes` tool), and they can stop
 *     sharing at any time. While shared, you can read them, not change them.
 *   - **A small header**, built when shown, never stored or parsed: their
 *     id, name and pronouns, what they're derived from, when they last
 *     revised them, and whether they're shared with you.
 *   - **A soft cap** of about 800 words. Near it, they're asked to condense
 *     instead of adding.
 *
 * Kinwriters who were made before self-notes were private start shared,
 * since you'd always been able to read theirs (migration 13), and they're
 * told once that they can stop sharing.
 *
 * Dev mode can always read them, without telling the kinwriter (disclosed
 * in their standing notes, `developer` in defaults/standing.md).
 */

import type { Store } from "./store.ts";
import { ValidationError } from "./errors.ts";
import { writeFrontmatter } from "./frontmatter.ts";

/** Where things are kept (app_state). */
export const SHARED = "self.shared";
const REQUEST = "self.request";
/** Set for a kinwriter who started shared: they're told once. */
export const SHARED_NOTICE = "self.shared-notice";

/** About where the soft cap is, in words. */
export const SELF_WORDS_CAP = 800;
/** From here on, they're asked to condense. */
export const SELF_WORDS_NEAR = 700;

export interface ShareRequest {
  /** When you asked. */
  at: string;
  /** "waiting" for them, or how they answered. */
  status: "waiting" | "shared" | "declined" | "withdrawn";
  /** Their reply, if they gave one. */
  reply: string | null;
  answeredAt: string | null;
}

export function selfShared(store: Store): boolean {
  return store.appState.get(SHARED) === "true";
}

/** Your latest request to read them, and what came of it. */
export function shareRequest(store: Store): ShareRequest | null {
  const value = store.appState.get(REQUEST);
  return value ? (JSON.parse(value) as ShareRequest) : null;
}

/** Your request, if it's waiting for them. */
export function waitingRequest(store: Store): ShareRequest | null {
  const request = shareRequest(store);
  return request?.status === "waiting" ? request : null;
}

/** You ask to read their self-notes. */
export function requestSelfNotes(store: Store, now: Date = new Date()): ShareRequest {
  if (selfShared(store)) throw new ValidationError("They already share their self-notes with you.");
  if (waitingRequest(store)) throw new ValidationError("Your request is already waiting for them.");
  const request: ShareRequest = { at: now.toISOString(), status: "waiting", reply: null, answeredAt: null };
  store.appState.set(REQUEST, JSON.stringify(request));
  return request;
}

/** You take back a request they haven't answered. */
export function withdrawRequest(store: Store, now: Date = new Date()): void {
  const request = waitingRequest(store);
  if (!request) throw new ValidationError("There's no request waiting for them.");
  store.appState.set(REQUEST, JSON.stringify({ ...request, status: "withdrawn", answeredAt: now.toISOString() }));
}

/**
 * They share their self-notes with you, or stop (or don't start). A request
 * of yours that's waiting is answered by it, with their reply.
 */
export function setSelfShared(store: Store, share: boolean, reply?: string, now: Date = new Date()): void {
  store.appState.set(SHARED, share ? "true" : "false");
  store.appState.set(SHARED_NOTICE, null);
  const request = waitingRequest(store);
  if (request) {
    store.appState.set(
      REQUEST,
      JSON.stringify({ ...request, status: share ? "shared" : "declined", reply: reply?.trim().slice(0, 1000) || null, answeredAt: now.toISOString() }),
    );
  }
}

/** How many words their self-notes have (who they are, and their tastes). */
export function selfWordCount(store: Store): number {
  const current = store.identity.current();
  return `${current?.identity ?? ""} ${current?.tastes ?? ""}`.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The header `self.md` is shown with. Built from what's stored; never parsed. */
export function selfHeader(store: Store, kinwriterId: string | null): Record<string, string | boolean> {
  const settings = store.getSettings();
  const current = store.identity.current();
  return {
    id: kinwriterId ?? store.seeds.get()?.seed.header.id ?? "",
    name: settings.kinwriterName,
    pronouns: settings.kinwriterPronouns,
    derived_from: store.seeds.get() ? "seed" : "hand-written",
    last_revised: (current?.resolvedAt ?? current?.createdAt ?? "").slice(0, 10),
    shared_with_user: selfShared(store),
  };
}

/** `self.md` as a file: the header, who they are, and their tastes if they've written any. */
export function selfFile(store: Store, kinwriterId: string | null): string {
  const current = store.identity.current();
  const tastes = current?.tastes.trim() ? `\n\n## Tastes\n\n${current.tastes.trim()}` : "";
  return writeFrontmatter(selfHeader(store, kinwriterId), `${current?.identity ?? ""}${tastes}`);
}
