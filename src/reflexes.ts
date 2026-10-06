/**
 * Reflexes: your kinwriter's quick double-check on their own follow-through.
 *
 * They kept saying "done!" without calling the tool. So, after they draft a
 * reply on a turn with tools, Jev reads the draft and answers a few fixed
 * questions (`defaults/reflexes.md`), each in two phrasings that must agree:
 *
 *   - follow-through: they said they edited, deleted, noted or posted
 *     something, or that they'd come back later, without the tool. Only
 *     outside story channels: in a story, "I fixed it" is a character
 *     talking. A check is skipped if they used its tool this turn or in
 *     the last half hour, and Jev sees what they did recently, so a true
 *     "I fixed that earlier" doesn't count;
 *   - chances: something lasting worth keeping, a detail worth checking.
 *     These start off: their questions have no crisp answer, so they
 *     misfire. Their owner can turn them on.
 *
 * Jev decides nothing. On a yes, the kinwriter gets one short reminder and
 * one more round (src/kinwriter.ts): they act or don't, rewrite or keep the
 * draft (`[same]`). It's their instrument: their prompt says so, the user
 * sees each reminder in the tool log, and they can turn any check off
 * (`set_my_reflexes`).
 */

import type { Decider } from "./jev.ts";
import type { ToolSpec } from "./nanogpt.ts";
import type { Store } from "./store.ts";
import type { ChannelKind, ToolCallRecord } from "./types.ts";
import { fill, wording } from "./wording.ts";

export interface Reflex {
  id: string;
  kind: "follow-through" | "chance";
  channels: string[];
  tools: string[];
  question: string;
  rephrased: string;
  reminder: string;
  /** Follow-through checks: what Jev read the draft as saying ("changed an earlier message"). */
  claim: string;
  /** Whether it's on until they choose (`default: off` in the wording). */
  onByDefault: boolean;
}

/** Every check, from defaults/reflexes.md. */
export function allReflexes(): Reflex[] {
  const words = wording("reflexes");
  return Object.entries(words)
    .filter(([name]) => name.startsWith("reflex-"))
    .map(([name, text]) => {
      const fields: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const m = line.match(/^([a-z]+):\s*(.*)$/);
        if (m) fields[m[1]!] = m[2]!.trim();
      }
      const list = (value = "") => value.split(",").map((v) => v.trim()).filter(Boolean);
      return {
        id: name.slice("reflex-".length),
        kind: fields.kind === "chance" ? "chance" : "follow-through",
        channels: list(fields.channels || "all"),
        tools: list(fields.tools),
        question: fields.question ?? "",
        rephrased: fields.rephrased ?? fields.question ?? "",
        reminder: fields.reminder ?? "",
        claim: fields.claim ?? "",
        onByDefault: fields.default !== "off",
      } as Reflex;
    })
    .filter((r) => r.question && r.reminder);
}

const OFF = "reflexes.off";

/** The checks they've turned off (until they choose, the ones that start off). */
export function reflexesOff(store: Store): Set<string> {
  const value = store.appState.get(OFF);
  return new Set(value ? (JSON.parse(value) as string[]) : allReflexes().filter((r) => !r.onByDefault).map((r) => r.id));
}

/** How far back "what they did recently" goes: a check is skipped if they used its tool in this time. */
export const RECENT_MINUTES = 30;

/** They turn a check off or on. */
export function setReflex(store: Store, id: string, on: boolean): void {
  if (!allReflexes().some((r) => r.id === id)) throw new Error(`There's no check called "${id}".`);
  const off = reflexesOff(store);
  if (on) off.delete(id);
  else off.add(id);
  store.appState.set(OFF, JSON.stringify([...off]));
}

/** The checks that apply to a draft here: on, for this kind of channel, and not already done this turn. */
export function applicableReflexes(store: Store, kind: ChannelKind, usedTools: string[]): Reflex[] {
  const off = reflexesOff(store);
  return allReflexes().filter(
    (r) =>
      !off.has(r.id) &&
      (r.channels.includes("all") || r.channels.includes(kind)) &&
      !r.tools.some((t) => usedTools.includes(t)),
  );
}

/**
 * Ask Jev about a draft. Returns the reminders that came up (none if Jev
 * is off, unsure, or failed: a reflex never gets in the way of a reply).
 */
export async function reflexReminders(
  store: Store,
  decider: Decider | null | undefined,
  input: { kind: ChannelKind; userMessage: string; draft: string; usedTools: string[] },
): Promise<Reflex[]> {
  if (!decider?.enabled() || !input.draft.trim()) return [];
  // What they did lately counts too: "I fixed that" about an edit from their last turn is true.
  const recent = store.toolLog.doneSince(new Date(Date.now() - RECENT_MINUTES * 60_000).toISOString());
  const reflexes = applicableReflexes(store, input.kind, [...input.usedTools, ...recent.map((c) => c.name)]);
  if (reflexes.length === 0) return [];
  const state = fill(wording("reflexes").state ?? "", {
    recent: recent.length ? recent.map((c) => `- ${c.summary || c.name}`).join("\n") : "(nothing)",
    user: input.userMessage.trim() || "(none: they're writing on their own)",
    draft: input.draft.trim(),
    tools: input.usedTools.length ? input.usedTools.join(", ") : "none",
    // What's already in the notebook, so "something new" means new.
    known: knownNames(store),
  });
  try {
    const verdicts = await decider.askSeries(
      state,
      reflexes.map((r) => ({ id: r.id, phrasings: [r.question, r.rephrased] })),
      store.getSettings().decisionConfidence,
      { purpose: "Reflexes" },
    );
    return reflexes.filter((r) => verdicts.get(r.id)?.verdict === "yes");
  } catch (error) {
    console.warn(`[reflexes] Jev couldn't read the draft: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/** How many notebook names Jev is shown. */
const KNOWN_LIMIT = 150;

/** The names already in the notebook (that they can see), for Jev. */
function knownNames(store: Store): string {
  const names = store.notebook.listEntries("friend").map((e) => e.name);
  if (names.length === 0) return "(nothing yet)";
  return names.slice(0, KNOWN_LIMIT).join(", ") + (names.length > KNOWN_LIMIT ? `, and ${names.length - KNOWN_LIMIT} more` : "");
}

/** The note they get, with each reminder that came up. */
export function reflexNudge(reminders: Reflex[]): string {
  return fill(wording("reflexes").nudge ?? "", { reminders: reminders.map((r) => `- ${r.reminder}`).join("\n") });
}

/** The choice offered in the round after a reminder, beside their tools: post the draft without acting. */
export const KEEP_DRAFT = "keep_my_draft";

export function keepDraftSpec(): ToolSpec {
  return {
    type: "function",
    function: {
      name: KEEP_DRAFT,
      description: wording("reflexes")["keep-draft"] ?? "Post your draft as it is.",
      parameters: { type: "object", properties: { reason: { type: "string", description: "Optional: why, in a few words. The user sees it." } } },
    },
  };
}

/**
 * After a turn with a reminder: did they act on it? Their reminder's entry
 * in the tool log says, and for a follow-through check they posted without
 * acting on, it carries what Jev read their draft as saying, for the line
 * under their message. Returns the checks they didn't act on.
 */
export function settleReflexes(store: Store, calls: ToolCallRecord[], posted: boolean): string[] {
  const index = calls.findIndex((c) => c.name === "reflex");
  if (index === -1) return [];
  const record = calls[index]!;
  const checks = (JSON.parse(record.arguments) as { checks: string[] }).checks;
  const after = calls.slice(index + 1).filter((c) => c.status === "ok");
  const byId = new Map(allReflexes().map((r) => [r.id, r]));
  const acted = checks.filter((id) => byId.get(id)?.tools.some((t) => after.some((c) => c.name === t)));
  const unacted = checks.filter((id) => !acted.includes(id));
  const kept = after.find((c) => c.name === KEEP_DRAFT);
  // Flagged for you: follow-through checks they posted without acting on.
  const flagged = posted ? unacted.filter((id) => byId.get(id)?.kind === "follow-through" && byId.get(id)?.claim) : [];
  const outcome = [
    acted.length ? `and acted on ${acted.join(", ")}` : "",
    unacted.length ? (posted ? `and posted without acting on ${unacted.join(", ")}` : `and didn't act on ${unacted.join(", ")}`) : "",
  ].filter(Boolean).join(", ");
  const previous = JSON.parse(record.result) as Record<string, unknown>;
  const keptWhy = kept ? ((JSON.parse(kept.arguments || "{}") as { reason?: string }).reason ?? true) : false;
  record.result = JSON.stringify({ ...previous, acted, unacted, kept: keptWhy, flagged: flagged.map((id) => byId.get(id)!.claim) });
  record.summary = `${record.summary} ${outcome}`;
  store.toolLog.settle(record.id, record.result, record.summary);
  return unacted;
}

/** A reply meaning "post my draft as it was". */
export function isSame(text: string): boolean {
  return /^\s*\[?\s*same\s*\]?\s*\.?\s*$/i.test(text);
}
