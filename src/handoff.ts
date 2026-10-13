/**
 * The seed handoff (design/kinwriter-generation/spec.md, "Orientation
 * handoff"): how a kinwriter's seed becomes their own self-notes.
 *
 * On Accept, their self-notes (their identity, src/identity.ts) start as a
 * copy of the seed's body, in the third person. From then on:
 *
 *   - **Orientation together:** from its first step they're told that this
 *     is a starting draft of who they are, written before they existed:
 *     keep what fits, change what doesn't, and rewrite it in the first
 *     person by the end. Its Left open questions go into the interview,
 *     and the write-up is where they rewrite it, with the suggested
 *     headings, and where Leanings become choices.
 *   - **On their own:** they rewrite it alone in the write-up. Left open
 *     moves to "Still figuring out", to bring up naturally in early OOC.
 *   - **Skipped (or the rewrite never happened):** at the start of their
 *     OOC conversations, until they've done it, they're asked to.
 *
 * The rewrite always saves (`revise_identity` saves at once, whatever you
 * choose about the orientation's conversation). Code never parses their
 * self-notes after that: their structure is theirs.
 *
 * The wording is in defaults/seeds.md.
 */

import { seedSection } from "./seeds.ts";
import { selfShared, selfWordCount, SELF_WORDS_CAP, SELF_WORDS_NEAR, SHARED_NOTICE } from "./selfnotes.ts";
import type { Store } from "./store.ts";
import { fill, wording } from "./wording.ts";

/**
 * Whether their self-notes are still the seed's draft: they began as a seed
 * and haven't rewritten who they are since.
 */
export function stillSeedDraft(store: Store): boolean {
  const seed = store.seeds.get();
  if (!seed) return false;
  const body = seed.seed.body.trim();
  return !store.identity.history().some((v) => v.author === "friend" && v.status === "accepted" && v.identity.trim() !== body);
}

/** The seed's Left open questions, or Leanings, as written. */
function seedPart(store: Store, heading: "Left open" | "Leanings"): string {
  const seed = store.seeds.get();
  return seed ? seedSection(seed.seed.body, heading) : "";
}

/**
 * What an orientation's guide adds while their self-notes are still the
 * seed's draft, for the step it's on. "" otherwise.
 */
export function seedHandoff(store: Store, version: "full" | "returning", stepId: string | undefined): string {
  if (!stillSeedDraft(store)) return "";
  const words = wording("seeds");
  const alone = version === "returning";
  const parts = [words[alone ? "handoff-alone" : "handoff"] ?? ""];
  const leftOpen = seedPart(store, "Left open");
  if (!alone && stepId === "interview" && leftOpen) parts.push(fill(words["handoff-interview"] ?? "", { "left-open": leftOpen }));
  if (stepId === "writeup") {
    parts.push(fill(words[alone ? "handoff-writeup-alone" : "handoff-writeup"] ?? "", { "left-open": leftOpen || "(none)", leanings: seedPart(store, "Leanings") || "(none)" }));
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

/**
 * Notices about their self-notes, for a turn with tools: that they started
 * shared (once), that they're near the cap, and, in OOC, outside an
 * orientation, that the seed's draft is waiting for their rewrite.
 */
export function selfNotices(store: Store, where: { ooc: boolean; orienting: boolean }): string[] {
  const words = wording("seeds");
  const notices: string[] = [];
  if (store.appState.get(SHARED_NOTICE) && selfShared(store)) notices.push(words["shared-notice"] ?? "");
  const count = selfWordCount(store);
  if (count >= SELF_WORDS_NEAR) notices.push(fill(words.condense ?? "", { words: count, cap: SELF_WORDS_CAP }));
  if (where.ooc && !where.orienting && stillSeedDraft(store)) notices.push(words["ooc-rewrite"] ?? "");
  return notices.filter((n) => n.trim());
}
