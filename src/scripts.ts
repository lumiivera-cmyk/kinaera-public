/**
 * Scripts: tool calls your kinwriter writes down once and runs exactly.
 *
 * Calling tools through a model is unpredictable: it may skip a step, call
 * them in another order, or get an argument slightly wrong on the day. A
 * script takes the model out of it. Your kinwriter saves an ordered list of
 * steps (a tool and its arguments, written once, while they're thinking
 * about it), and later Kinaera runs them one after another, as written,
 * with no model in between.
 *
 *   - **`run_script`** runs one in the middle of a turn.
 *   - **`schedule_wakeup` with `script`** runs one later as a *tools-only
 *     turn*: no model call at all. If every step works, that's it (the tool
 *     log shows each step). If one fails, the run stops there and the
 *     wake-up turns into an ordinary one whose note says which step failed
 *     and why, so your kinwriter wakes up to it and can fix the step or the
 *     script and run it again from that step.
 *
 * A step fails when its tool returns an error, or when it has an `expect`
 * and the result doesn't contain that text. An `optional` step's failure
 * is reported but doesn't stop the run.
 *
 * Scripts are opt-in, per kinwriter (Settings → the kinwriter page,
 * "Scripts"); off, none of these tools are offered and nothing scheduled
 * runs. They're kept in `app_state`, like the tool map.
 */

import { ValidationError } from "./errors.ts";
import type { Store } from "./store.ts";

const KEY = "scripts";

export const SCRIPT_LIMIT = 20;
export const STEP_LIMIT = 12;
export const NAME_LIMIT = 40;
const ABOUT_LIMIT = 300;
const EXPECT_LIMIT = 200;
const ARGS_LIMIT = 4000;

/** The script tools themselves, and tools a script can't call. */
export const SCRIPT_TOOLS = ["save_script", "run_script", "list_my_scripts", "delete_script", "queue_scripts", "resume_script_queue"];
const NOT_IN_SCRIPTS = new Set([
  ...SCRIPT_TOOLS,
  // Choices only a model makes in the moment.
  "do_nothing",
  "keep_my_draft",
  // A model call of its own, once per turn: the unpredictability scripts avoid.
  "consult",
]);

export interface ScriptStep {
  tool: string;
  args: Record<string, unknown>;
  /** The step only counts as working if its result contains this (ignoring case). */
  expect?: string;
  /** A failure is reported, but the run carries on. */
  optional?: boolean;
}

export interface StepReport {
  step: number;
  tool: string;
  ok: boolean;
  /** The tool's summary line, or what went wrong. */
  summary: string;
  /** What the tool returned (for the kinwriter; private tools' results are only in their turn). */
  result?: unknown;
}

export interface ScriptReport {
  script: string;
  at: string;
  /** Every step that ran worked (optional failures aside). */
  ok: boolean;
  /** The step it stopped at, from 1. */
  failedStep?: number;
  error?: string;
  steps: StepReport[];
}

export interface Script {
  name: string;
  about: string;
  steps: ScriptStep[];
  updatedAt: string;
  lastRun?: Omit<ScriptReport, "steps"> & { ran: number };
}

const key = (name: string) => name.trim().toLowerCase();

/**
 * Whether they've been introduced to scripts: told once, on their first
 * turn with tools after scripts are turned on, what changed and what's
 * new, so they can try it and put it in their tool map.
 */
export const INTRODUCED = "scripts.introduced";

export function needsIntroduction(store: Store): boolean {
  return scriptsOn(store) && !store.appState.get(INTRODUCED);
}

export function scriptsOn(store: Store): boolean {
  return store.getSettings().scripts === true;
}

export function listScripts(store: Store): Script[] {
  const value = store.appState.get(KEY);
  return value ? (JSON.parse(value) as Script[]) : [];
}

function saveAll(store: Store, scripts: Script[]): void {
  store.appState.set(KEY, JSON.stringify(scripts));
}

export function findScript(store: Store, name: string): Script | undefined {
  return listScripts(store).find((s) => key(s.name) === key(name));
}

/** A mistake in a script, explained to the kinwriter. */
export class ScriptError extends ValidationError {}

/**
 * Check steps as the model wrote them: each a known tool a script may
 * call, with arguments as an object (or JSON text).
 */
export function parseSteps(input: unknown, toolNames: string[]): ScriptStep[] {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ScriptError('"steps" must be a list, like [{"tool": "read_journal", "args": {}}].');
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new ScriptError('"steps" must be a list of at least one step.');
  if (raw.length > STEP_LIMIT) throw new ScriptError(`A script can have ${STEP_LIMIT} steps at most.`);
  return raw.map((item, i) => {
    const n = i + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ScriptError(`Step ${n} must be an object with "tool" and "args".`);
    const step = item as Record<string, unknown>;
    const tool = typeof step.tool === "string" ? step.tool.trim() : "";
    if (!tool) throw new ScriptError(`Step ${n} needs a "tool".`);
    if (NOT_IN_SCRIPTS.has(tool)) throw new ScriptError(`Step ${n}: ${tool} can't be used in a script.`);
    if (!toolNames.includes(tool)) throw new ScriptError(`Step ${n}: there's no tool called "${tool}".`);
    let args = step.args ?? step.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        throw new ScriptError(`Step ${n}: "args" isn't valid JSON.`);
      }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ScriptError(`Step ${n}: "args" must be an object, like {"name": "Mara"}.`);
    if (JSON.stringify(args).length > ARGS_LIMIT) throw new ScriptError(`Step ${n}: its arguments are too long (${ARGS_LIMIT} characters at most).`);
    const out: ScriptStep = { tool, args: args as Record<string, unknown> };
    if (step.expect !== undefined && step.expect !== null && step.expect !== "") {
      if (typeof step.expect !== "string" || step.expect.length > EXPECT_LIMIT) throw new ScriptError(`Step ${n}: "expect" must be text, ${EXPECT_LIMIT} characters at most.`);
      out.expect = step.expect;
    }
    if (step.optional === true) out.optional = true;
    return out;
  });
}

/** Save (or replace) a script by name. */
export function saveScript(store: Store, name: string, about: string, steps: ScriptStep[]): { script: Script; replaced: boolean } {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new ScriptError("A script needs a name.");
  if (clean.length > NAME_LIMIT) throw new ScriptError(`Keep the name to ${NAME_LIMIT} characters.`);
  const scripts = listScripts(store);
  const at = scripts.findIndex((s) => key(s.name) === key(clean));
  if (at < 0 && scripts.length >= SCRIPT_LIMIT) throw new ScriptError(`You have ${SCRIPT_LIMIT} scripts already. Delete one first.`);
  const script: Script = { name: clean, about: about.trim().slice(0, ABOUT_LIMIT), steps, updatedAt: new Date().toISOString() };
  if (at >= 0) scripts[at] = script;
  else scripts.push(script);
  saveAll(store, scripts);
  return { script, replaced: at >= 0 };
}

export function deleteScript(store: Store, name: string): Script {
  const scripts = listScripts(store);
  const at = scripts.findIndex((s) => key(s.name) === key(name));
  if (at < 0) throw new ScriptError(noSuchScript(store, name));
  const [gone] = scripts.splice(at, 1);
  saveAll(store, scripts);
  return gone!;
}

export function noSuchScript(store: Store, name: string): string {
  const names = listScripts(store).map((s) => s.name);
  return `There's no script called "${name}". Scripts: ${names.join(", ") || "(none yet)"}.`;
}

/** What running one tool produced, as much as a script needs. */
export interface StepOutcome {
  ok: boolean;
  result: unknown;
  summary: string;
}

/**
 * Run a script's steps in order, from `fromStep` (1-based), stopping at
 * the first failure that isn't optional. `run` runs one tool (as the
 * kinwriter, in the turn's context). The report is kept on the script as
 * its last run.
 */
export async function runScript(
  store: Store,
  script: Script,
  run: (step: ScriptStep, index: number) => Promise<StepOutcome>,
  fromStep = 1,
): Promise<ScriptReport> {
  if (!Number.isInteger(fromStep) || fromStep < 1 || fromStep > script.steps.length) {
    throw new ScriptError(`"${script.name}" has steps 1 to ${script.steps.length}.`);
  }
  const report: ScriptReport = { script: script.name, at: new Date().toISOString(), ok: true, steps: [] };
  for (let i = fromStep - 1; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    const outcome = await run(step, i);
    let ok = outcome.ok;
    let summary = outcome.summary;
    if (ok && step.expect && !JSON.stringify(outcome.result ?? "").toLowerCase().includes(step.expect.toLowerCase())) {
      ok = false;
      summary = `It ran, but its result didn't contain "${step.expect}" (${outcome.summary}).`;
    }
    report.steps.push({ step: i + 1, tool: step.tool, ok, summary, result: outcome.result });
    if (!ok && !step.optional) {
      report.ok = false;
      report.failedStep = i + 1;
      report.error = summary;
      break;
    }
  }
  // Kept on the script (re-read: a step may have changed the list).
  const scripts = listScripts(store);
  const saved = scripts.find((s) => key(s.name) === key(script.name));
  if (saved) {
    const { steps, ...rest } = report;
    saved.lastRun = { ...rest, ran: steps.length };
    saveAll(store, scripts);
  }
  return report;
}

/** One line for people: "ran their script "tidy": 3 steps worked". */
export function reportSummary(report: ScriptReport): string {
  const worked = report.steps.filter((s) => s.ok).length;
  return report.ok
    ? `ran their script "${report.script}": ${worked} of ${report.steps.length} step${report.steps.length === 1 ? "" : "s"} worked`
    : `ran their script "${report.script}": stopped at step ${report.failedStep} (${report.error})`;
}

/**
 * The note a failed scheduled run leaves, for the wake-up it becomes: what
 * failed, and how to try again.
 */
export function failureNote(report: ScriptReport, note: string): string {
  const step = report.steps.find((s) => s.step === report.failedStep);
  const before = report.steps.filter((s) => s.ok).map((s) => `step ${s.step} (${s.tool}) worked`);
  return [
    `Your script "${report.script}" ran on its own and stopped at step ${report.failedStep} (${step?.tool}): ${report.error}`,
    before.length ? `Before that, ${before.join(", ")}.` : "",
    `To try again from there, fix what's wrong (save_script replaces the script) and call run_script with "name": "${report.script}" and "from_step": ${report.failedStep}. Or leave it.`,
    note ? `Your note when you scheduled it: ${note}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// ------------------------------------------------------------ the queue

/**
 * Scripts queued to run in order, one per turn, in one channel. Each runs
 * at the start of a turn of its own, before the model is asked, and its
 * results are put in front of them in that turn, so they can read what it
 * found and act on it. Another turn follows by itself while scripts are
 * waiting. A failed step pauses the queue at that step; take_another_turn
 * carries on from it.
 */
export interface ScriptQueue {
  channelId: string;
  items: { name: string; from: number }[];
  paused: boolean;
}

const QUEUE = "scripts.queue";
export const QUEUE_LIMIT = 30;

export function scriptQueue(store: Store): ScriptQueue | null {
  const value = store.appState.get(QUEUE);
  const queue = value ? (JSON.parse(value) as ScriptQueue) : null;
  return queue && queue.items.length > 0 ? queue : null;
}

export function setScriptQueue(store: Store, queue: ScriptQueue | null): void {
  store.appState.set(QUEUE, queue && queue.items.length > 0 ? JSON.stringify(queue) : null);
}

/** Scripts by name, as queue items (each must exist). */
function queueItems(store: Store, names: string[]): ScriptQueue["items"] {
  return names.map((name) => {
    const script = findScript(store, name);
    if (!script) throw new ScriptError(noSuchScript(store, name));
    return { name: script.name, from: 1 };
  });
}

/**
 * Queue scripts by name. Replaces any queue there was, or with `add`,
 * goes on the end of it (keeping it paused, if it is). An empty list
 * (without `add`) clears it.
 */
export function queueScripts(store: Store, channelId: string, names: string[], add = false): ScriptQueue | null {
  const current = scriptQueue(store);
  const items = [...(add && current ? current.items : []), ...queueItems(store, names)];
  if (items.length > QUEUE_LIMIT) throw new ScriptError(`Queue ${QUEUE_LIMIT} scripts at most.`);
  const queue = items.length ? { channelId: add && current ? current.channelId : channelId, items, paused: add && current ? current.paused : false } : null;
  setScriptQueue(store, queue);
  return queue;
}

/**
 * Recover a paused queue without losing the rest of the plan. The script
 * that failed is at the front, at the step that failed. Then, in order:
 * `skip` drops it; `fromStep` changes where it starts (1 to run it whole
 * again, after a fix); `insert` puts scripts in front of it (a one-off
 * fix-up, say). Everything after it stays as it was. It carries on with
 * the next turn.
 */
export function resumeScriptQueue(store: Store, options: { skip?: boolean; fromStep?: number; insert?: string[] } = {}): ScriptQueue | null {
  const queue = scriptQueue(store);
  if (!queue) throw new ScriptError("There's no script queue to carry on with.");
  let items = [...queue.items];
  if (options.skip) items = items.slice(1);
  else if (options.fromStep !== undefined) {
    const script = findScript(store, items[0]!.name);
    const steps = script?.steps.length ?? 1;
    if (!Number.isInteger(options.fromStep) || options.fromStep < 1 || options.fromStep > steps) {
      throw new ScriptError(`"${items[0]!.name}" has steps 1 to ${steps}.`);
    }
    items[0] = { ...items[0]!, from: options.fromStep };
  }
  if (options.insert?.length) items = [...queueItems(store, options.insert), ...items];
  if (items.length > QUEUE_LIMIT) throw new ScriptError(`Queue ${QUEUE_LIMIT} scripts at most.`);
  const next = items.length ? { ...queue, items, paused: false } : null;
  setScriptQueue(store, next);
  return next;
}

/** A queue waiting to run its next script in this channel (not paused). */
export function queueReady(store: Store, channelId: string): ScriptQueue | null {
  const queue = scriptQueue(store);
  return queue && !queue.paused && queue.channelId === channelId ? queue : null;
}

/**
 * Run the next queued script. On success it leaves the queue; on a failed
 * step the queue pauses there (that script, from that step). A script
 * deleted since it was queued is skipped, and said so.
 */
export async function runNextQueued(
  store: Store,
  channelId: string,
  run: (script: Script, fromStep: number) => Promise<ScriptReport>,
): Promise<{ report: ScriptReport | null; skipped?: string; left: number } | null> {
  const queue = queueReady(store, channelId);
  if (!queue) return null;
  const [next, ...rest] = queue.items;
  const script = findScript(store, next!.name);
  if (!script) {
    setScriptQueue(store, { ...queue, items: rest });
    return { report: null, skipped: next!.name, left: rest.length };
  }
  const report = await run(script, Math.min(next!.from, script.steps.length));
  const now = scriptQueue(store) ?? queue;
  if (report.ok) setScriptQueue(store, { ...now, items: now.items.slice(1) });
  else setScriptQueue(store, { ...now, paused: true, items: [{ name: script.name, from: report.failedStep! }, ...now.items.slice(1)] });
  return { report, left: report.ok ? now.items.length - 1 : now.items.length };
}

/** take_another_turn: a paused queue carries on, from where it stopped. */
export function resumeQueue(store: Store): void {
  const queue = scriptQueue(store);
  if (queue?.paused) setScriptQueue(store, { ...queue, paused: false });
}
