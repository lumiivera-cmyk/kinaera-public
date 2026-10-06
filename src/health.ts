/**
 * The health view (orientation stage 3): how a kinwriter's tools and notes
 * are doing, by their **shape**, never their content. It's for whoever is
 * building Kinaera, to spot something stuck without reading anything
 * private.
 *
 * What it looks at:
 *   - tool calls that keep failing, overall or with the very same arguments
 *     (a delete that never goes through), from the tool log;
 *   - the same note rewritten over and over (a writing tool called many
 *     times in a day);
 *   - sections stuck at their length limit (identity, self-page, journal
 *     entries, drafts, wake-ups);
 *   - a journal with no kept entries;
 *   - wake-ups that failed.
 *
 * It reports counts, tool names, lengths and limits. It never returns what
 * was written: the tool log keeps private tools' arguments as "(private)"
 * anyway, and identical arguments are compared, not shown.
 */

import type { Store } from "./store.ts";
import { IDENTITY_LIMIT } from "./identity.ts";
import { ENTRY_LIMIT } from "./journal.ts";
import { DRAFT_LIMIT } from "./drafts.ts";
import { SCHEDULE_LIMIT } from "./schedule.ts";
import { STANDING_LIMIT, SECTION_LIMIT } from "./selfpage.ts";

/** One thing worth a look, or a line saying all is well. */
export interface HealthFinding {
  /** "watch": worth a look. "ok": nothing wrong there. */
  level: "watch" | "ok";
  /** Which part: "tools", "notes", "limits", "journal", "wake-ups". */
  area: string;
  text: string;
}

/** Each tool's calls over the week, by outcome. */
export interface ToolHealth {
  name: string;
  ok: number;
  failed: number;
  lastAt: string;
}

export interface HealthReport {
  findings: HealthFinding[];
  tools: ToolHealth[];
  /** How full each limited thing is, from 0 to 1. */
  limits: { what: string; used: number; limit: number }[];
}

/** Calls failing at least this often (and more often than not) in a week are worth a look. */
export const FAILING_CALLS = 3;
/** The same failing call this many times is a loop. */
export const SAME_FAILURE = 3;
/** A writing tool used this many times in a day is rewriting the same thing. */
export const REWRITES_PER_DAY = 5;
/** A limit this full is "stuck at its limit". */
export const NEAR_LIMIT = 0.9;
/** A journal with this many entries and none kept is worth a look. */
export const UNKEPT_JOURNAL = 8;

/** Tools that write or rewrite a note of theirs (as opposed to adding something new each time). */
const REWRITING_TOOLS = [
  "revise_identity",
  "write_self_page",
  "write_profile_note",
  "note_relationship",
  "keep_pattern_note",
  "edit_journal_entry",
  "save_draft",
  "edit_my_message",
  "set_status",
];

const DAY = 86_400_000;

interface CallRow {
  name: string;
  arguments: string;
  status: "ok" | "error";
  created_at: string;
}

export function healthReport(store: Store, now = Date.now()): HealthReport {
  const findings: HealthFinding[] = [];
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const dayAgo = new Date(now - DAY).toISOString();
  const calls = store.db
    .query("SELECT name, arguments, status, created_at FROM tool_calls WHERE created_at >= $since ORDER BY created_at")
    .all({ since: weekAgo }) as CallRow[];

  // Each tool's week.
  const byTool = new Map<string, ToolHealth>();
  for (const call of calls) {
    const tool = byTool.get(call.name) ?? { name: call.name, ok: 0, failed: 0, lastAt: call.created_at };
    if (call.status === "ok") tool.ok += 1;
    else tool.failed += 1;
    tool.lastAt = call.created_at;
    byTool.set(call.name, tool);
  }
  const tools = [...byTool.values()].sort((a, b) => b.ok + b.failed - (a.ok + a.failed));

  // Tools that keep failing.
  for (const tool of tools) {
    if (tool.failed >= FAILING_CALLS && tool.failed > tool.ok) {
      findings.push({ level: "watch", area: "tools", text: `${tool.name} failed ${tool.failed} of ${tool.ok + tool.failed} times this week.` });
    }
  }
  // The very same call failing again and again (compared, never shown).
  const sameFailures = new Map<string, { name: string; count: number }>();
  for (const call of calls.filter((c) => c.status === "error" && c.arguments !== "(private)")) {
    const key = `${call.name}\u0000${call.arguments}`;
    const entry = sameFailures.get(key) ?? { name: call.name, count: 0 };
    entry.count += 1;
    sameFailures.set(key, entry);
  }
  for (const { name, count } of sameFailures.values()) {
    if (count >= SAME_FAILURE) findings.push({ level: "watch", area: "tools", text: `${name} failed ${count} times with the very same arguments this week: something they keep trying doesn't go through.` });
  }

  // The same note rewritten over and over.
  for (const name of REWRITING_TOOLS) {
    const today = calls.filter((c) => c.name === name && c.status === "ok" && c.created_at >= dayAgo).length;
    if (today >= REWRITES_PER_DAY) findings.push({ level: "watch", area: "notes", text: `${name} ran ${today} times in the last day: the same thing may be getting rewritten over and over.` });
  }

  // How full each limited thing is.
  const limits: HealthReport["limits"] = [];
  const identity = store.identity.current();
  if (identity) {
    limits.push({ what: "Identity", used: identity.identity.length, limit: IDENTITY_LIMIT });
    limits.push({ what: "Tastes", used: identity.tastes.length, limit: IDENTITY_LIMIT });
  }
  const page = store.selfPage.view();
  limits.push({ what: 'Self-page: "What I say about myself"', used: page.says.length, limit: SECTION_LIMIT });
  limits.push({ what: 'Self-page: "How I\'d like feedback"', used: page.feedback.length, limit: SECTION_LIMIT });
  limits.push({ what: "Self-page: short version", used: page.standing.length, limit: STANDING_LIMIT });
  const journal = store.journal.all();
  const longestEntry = Math.max(0, ...journal.map((e) => e.content.length));
  if (journal.length) limits.push({ what: "Longest journal entry", used: longestEntry, limit: ENTRY_LIMIT });
  const longestDraft = Math.max(0, ...store.drafts.all().map((d) => d.content.length));
  if (longestDraft) limits.push({ what: "Longest draft", used: longestDraft, limit: DRAFT_LIMIT });
  limits.push({ what: "Wake-ups scheduled", used: store.schedule.waiting().length, limit: SCHEDULE_LIMIT });
  for (const limit of limits) {
    if (limit.used / limit.limit >= NEAR_LIMIT) findings.push({ level: "watch", area: "limits", text: `${limit.what} is at ${Math.round((limit.used / limit.limit) * 100)}% of its limit.` });
  }

  // A journal with nothing kept fades entirely.
  const { entries, kept } = store.journal.counts();
  if (entries >= UNKEPT_JOURNAL && kept === 0) {
    findings.push({ level: "watch", area: "journal", text: `The journal has ${entries} entries and none kept, so all but the newest fade from their prompt.` });
  }

  // Wake-ups that failed.
  const failedWakes = store.wakeLog.recent(300).filter((w) => w.outcome === "failed" && w.at >= weekAgo);
  if (failedWakes.length) findings.push({ level: "watch", area: "wake-ups", text: `${failedWakes.length} wake-up${failedWakes.length === 1 ? "" : "s"} failed this week (Settings → Recent wake-ups has why).` });

  if (findings.length === 0) findings.push({ level: "ok", area: "all", text: "Nothing stuck: no repeated failures, rewrites, full sections or unkept journal." });
  return { findings, tools, limits };
}
