/**
 * Wake-ups: your kinwriter taking a turn without a message from you.
 *
 * The core rule is that *a kinwriter turn never requires a user message*.
 * Your kinwriter gets a turn when something happens:
 *
 *   - **you open the app** ("away" if you haven't written for a while,
 *     `awayHours`; otherwise just "opened")
 *   - **a scene ends** (one you ended, once it's been summarized)
 *   - **a suggestion of yours is waiting for their review**
 *   - **you answered something they asked** (src/inbox.ts)
 *   - **the heartbeat**, a timer: see src/heartbeat.ts
 *   - **orientation** and **the weekly look back**, in their practice
 *     channel (src/orientation.ts)
 *
 * A wake-up is a turn in your OOC channel (the one you talked in last),
 * with tools if the profile has them. Its prompt says why they're up, how
 * long it's been since you last wrote, what's waiting, and the summary of
 * a scene that just ended; OOC's prompt already has the server digest. They
 * can write, act with tools, or do nothing (`do_nothing`, or replying
 * `[nothing]` without tools). Doing nothing is always fine.
 *
 * ## Hard rules first, then your kinwriter decides
 *
 * These are plain code, with no model calls. They protect your sleep and
 * your balance; everything else is your kinwriter's call, made in their own
 * turn (no model is asked "is it the moment?" first).
 *
 * - **Chattiness** (`Settings.wakeups`) decides which events count at all:
 *   off; quiet (coming back after being away, and reviews); normal (also a
 *   scene ending); chatty (also any time you open the app).
 * - **Quiet hours**: never, except reviews (which are silent work).
 * - **A cooldown** between wake-ups (`wakeCooldownMinutes`, reviews 10).
 * - **At most one double text**: your kinwriter can reach out twice without
 *   hearing back (a follow-up is fine), but not a third time until you
 *   write (`MAX_UNANSWERED`). Reviews, and replying to your answer to their
 *   ask, are the exceptions (they still count as reaching out).
 * - **Never mid-conversation**: not right after you were talking, and not
 *   while they're writing in that channel. Not without an API key either.
 *
 * Every wake-up turn is in the wake-up log (Settings → Your kinwriter reaching
 * out), with what came of it.
 */

import type { Database } from "bun:sqlite";
import { BusyError, pickProfile, reviewsFor, type Kinwriter } from "./kinwriter.ts";
import type { WakeContext, WakeReason } from "./prompt.ts";
import type { Store } from "./store.ts";
import { splitScenes } from "./summaries.ts";
import type { Channel, Message } from "./types.ts";
import { orientationRunning, orientationState } from "./orientation.ts";
import { describeReading, describeTrend } from "./wellbeing.ts";
import { wording } from "./wording.ts";
import { toolSpecs } from "./tools.ts";

/** What can wake your kinwriter up from outside. */
export type WakeEvent = "opened" | "scene-ended" | "review" | "heartbeat" | "answer" | "lookback" | "scheduled" | "aside";

/** Details some events come with. */
export interface WakeDetail {
  /** "scene-ended": the channel and the scene break. "aside": the story they just posted in. */
  channelId?: string;
  breakId?: string;
  /** "lookback": the start of the week looked back on. */
  since?: string;
  /** "scheduled": the wake-up they set (src/schedule.ts). */
  scheduleId?: number;
}

/**
 * Turns your kinwriter takes in their own practice channel, for themselves:
 * they message no one, so the double-text limit and "never mid-conversation"
 * don't apply (src/orientation.ts). Orientation itself never comes through
 * here: you start it, and it runs at once.
 */
const OWN_TIME: WakeReason[] = ["orientation", "lookback"];

/** What came of a wake-up. */
export type WakeOutcome = "posted" | "quiet" | "failed";

/** One wake-up in the log. */
export interface WakeRecord {
  id: string;
  at: string;
  reason: WakeReason;
  outcome: WakeOutcome;
  channelId: string | null;
  detail: string;
}

/** What `Wakeups.event` did. */
export interface WakeResult {
  /** `null` when a hard rule stopped it (off, quiet hours, cooldown...): nothing was logged. */
  outcome: WakeOutcome | null;
  reason: WakeReason | null;
  detail: string;
  messages: Message[];
}


/** A review that finds them busy tries again this often, this many times (two minutes in all). */
const REVIEW_RETRY_MS = 2000;
const REVIEW_RETRIES = 60;

/** A scene break older than this (minutes) when summarized didn't "just" end the scene. */
export const FRESH_SCENE_MINUTES = 60;

/** Within this long (minutes) of the last message, you're mid-conversation. */
export const CONVERSATION_MINUTES = 30;

/** An aside (a moment in OOC after a story post) shows this many of the story's newest posts... */
export const ASIDE_POSTS = 3;
/** ...each cut to this many characters. */
export const ASIDE_CHARS = 1200;

/** How many times your kinwriter can reach out without hearing back (one double text, no more). */
export const MAX_UNANSWERED = 2;

// --------------------------------------------------------------- the log

interface WakeRow {
  id: string;
  at: string;
  reason: WakeReason;
  outcome: WakeOutcome;
  channel_id: string | null;
  detail: string;
}

/** The wake-up log: each turn your kinwriter took on their own, and what came of it. */
export class WakeLog {
  constructor(private readonly db: Database) {}

  add(record: Omit<WakeRecord, "id">): WakeRecord {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO wakeups (id, at, reason, outcome, channel_id, detail)
         VALUES ($id, $at, $reason, $outcome, $channelId, $detail)`,
      )
      .run({ id, ...record });
    // Keep the last few hundred; older ones don't help anyone.
    this.db.query("DELETE FROM wakeups WHERE id NOT IN (SELECT id FROM wakeups ORDER BY at DESC LIMIT 300)").run();
    return { id, ...record };
  }

  /** The newest wake-ups, newest first. */
  recent(limit = 30): WakeRecord[] {
    const rows = this.db.query("SELECT * FROM wakeups ORDER BY at DESC LIMIT $limit").all({ limit }) as WakeRow[];
    return rows.map((r) => ({ id: r.id, at: r.at, reason: r.reason, outcome: r.outcome, channelId: r.channel_id, detail: r.detail }));
  }

  /** When your kinwriter last actually took a wake-up turn (posted or chose quiet), for these reasons. */
  lastTurnAt(reasons?: WakeReason[]): Date | null {
    const rows = this.recent(300).filter(
      (r) => (r.outcome === "posted" || r.outcome === "quiet") && (!reasons || reasons.includes(r.reason)),
    );
    return rows[0] ? new Date(rows[0].at) : null;
  }

  /**
   * How many wake-ups wrote to you since `since` (all of them, if null).
   * Turns of their own (orientation, the look back) write in the practice
   * channel, to no one, so they don't count.
   */
  postedSince(since: Date | null): number {
    return this.recent(300).filter(
      (r) => r.outcome === "posted" && !OWN_TIME.includes(r.reason) && (!since || new Date(r.at) > since),
    ).length;
  }
}

// -------------------------------------------------------------- helpers

/** "3 minutes", "5 hours", "2 days". */
export function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Whether `now` is within quiet hours (`start` to `end`, wrapping past midnight). -1 means none. */
export function inQuietHours(now: Date, start: number, end: number): boolean {
  if (start < 0 || start === end) return false;
  const hour = now.getHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Which events count at each chattiness. */
const COUNTS: Record<string, WakeReason[]> = {
  off: [],
  quiet: ["away", "review", "heartbeat", "answer", "scheduled", "aside"],
  normal: ["away", "review", "heartbeat", "answer", "scheduled", "scene-ended", "aside"],
  chatty: ["away", "review", "heartbeat", "answer", "scheduled", "scene-ended", "opened", "aside"],
};

// ----------------------------------------------------------- wake-ups

/** Checks the hard rules, and gives your kinwriter the turn if they pass. */
export class Wakeups {
  private running = false;
  /** Told when a wake-up writes to you (for phone notifications, src/notify.ts). */
  onPosted: ((channel: Channel, messages: Message[]) => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly kinwriter: Kinwriter,
    private readonly hasApiKey: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Something happened that could wake your kinwriter. Resolves once their
   * turn is done (or a rule stopped it). Never throws.
   *
   * @param detail  For "scene-ended": the channel and the scene break.
   */
  async event(event: WakeEvent, detail: WakeDetail = {}): Promise<WakeResult> {
    const skip = (why: string): WakeResult => {
      // Not in the wake-up log (that's turns), but never silent.
      console.log(`[wake] ${event} skipped: ${why}`);
      return { outcome: null, reason: null, detail: why, messages: [] };
    };
    if (this.running) return skip("Your kinwriter is already waking up.");
    this.running = true;
    try {
      return await this.wake(event, detail, skip);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[wake] ${event} failed: ${message}`);
      return { outcome: "failed", reason: null, detail: message, messages: [] };
    } finally {
      this.running = false;
    }
  }

  private reviewRetry: ReturnType<typeof setTimeout> | null = null;

  /**
   * You suggested something: they answer now. If they're busy (another
   * wake-up, or writing in that channel), it waits for them to finish and
   * tries again, so a suggestion never just sits there.
   */
  requestReview(): void {
    if (this.reviewRetry) return; // already waiting to try
    const attempt = async (tries: number) => {
      const result = await this.event("review");
      const busy = result.outcome === null && /already waking up|writing there already/.test(result.detail);
      if (busy && tries < REVIEW_RETRIES) {
        this.reviewRetry = setTimeout(() => {
          this.reviewRetry = null;
          void attempt(tries + 1);
        }, REVIEW_RETRY_MS);
      }
    };
    void attempt(0);
  }

  /** Stop waiting to retry a review (when the app shuts down). */
  stopReviews(): void {
    if (this.reviewRetry) clearTimeout(this.reviewRetry);
    this.reviewRetry = null;
  }

  /**
   * Whether an event would be stopped by the hard rules: the reason why,
   * or `null` if it would go ahead.
   */
  blocked(event: WakeEvent, detail: WakeDetail = {}): string | null {
    const checked = this.rules(event, detail);
    return "skip" in checked ? checked.skip : null;
  }

  /** The hard rules, and where your kinwriter would write. */
  private rules(event: WakeEvent, detail: WakeDetail = {}): { skip: string } | { reason: WakeReason; channel: Channel; sinceMs: number | null } {
    const { store } = this;
    const settings = store.getSettings();
    const now = this.now();
    const skip = (why: string) => ({ skip: why });
    if (!this.hasApiKey) return skip("There's no API key yet.");
    // In an orientation, nothing else wakes them: it has their attention.
    if (orientationRunning(store)) return skip("They're in an orientation.");
    if (OWN_TIME.includes(event)) return this.ownTimeRules(event);

    // Where your kinwriter is, and how long since you wrote.
    const channels = store.listChannels();
    const all = channels.flatMap((c) => store.getMessages(c.id).filter((m) => m.kind === "post"));
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const yourLast = all.filter((m) => m.author === "user").at(-1) ?? null;
    const sinceMs = yourLast ? now.getTime() - new Date(yourLast.createdAt).getTime() : null;

    const reason: WakeReason =
      event === "opened" ? (sinceMs !== null && sinceMs >= settings.awayHours * 3_600_000 ? "away" : "opened") : event;

    // A review answers something you just suggested, like a reply to your
    // comment: right away, whatever the chattiness, quiet hours or cooldown.
    // Only if something's still waiting for them.
    if (reason === "review") {
      if (reviewsFor(store).length === 0) return skip("Nothing is waiting for their review.");
    } else {
      if (!COUNTS[settings.wakeups]!.includes(reason)) return skip(`"${reason}" doesn't wake your kinwriter at this chattiness.`);
      if (reason === "aside" && settings.asideMinutes < 0) return skip("A moment in OOC after story posts is turned off.");
      if (inQuietHours(now, settings.quietStart, settings.quietEnd)) return skip("It's quiet hours.");
      // Asides have their own cooldown: you're right there.
      const cooldown = reason === "aside" ? settings.asideMinutes : settings.wakeCooldownMinutes;
      const lastTurn = store.wakeLog.lastTurnAt(reason === "aside" ? [reason] : undefined);
      if (lastTurn && now.getTime() - lastTurn.getTime() < cooldown * 60_000) return skip("It's too soon after the last wake-up.");
    }
    // Their own plan (a wake-up they scheduled) isn't held back by your
    // silence; replying to your answer, and reviews, aren't reaching out.
    if (reason !== "review" && reason !== "answer" && reason !== "scheduled") {
      const unanswered = store.wakeLog.postedSince(yourLast ? new Date(yourLast.createdAt) : null);
      if (unanswered >= MAX_UNANSWERED) {
        return skip(`Your kinwriter already reached out ${unanswered === 2 ? "twice" : `${unanswered} times`}, and is waiting for you to write.`);
      }
    }
    // Opening the app, or the heartbeat, in the middle of a conversation.
    const last = all.at(-1);
    if ((reason === "opened" || reason === "heartbeat" || reason === "scheduled") && last && now.getTime() - new Date(last.createdAt).getTime() < CONVERSATION_MINUTES * 60_000) {
      return skip("You were talking just now: that's a conversation, not a wake-up.");
    }

    // A wake-up they scheduled for a channel happens there (if it's still there).
    const planned = reason === "scheduled" && detail.channelId ? channels.find((c) => c.id === detail.channelId) : undefined;
    const channel = planned ?? homeChannel(store, channels);
    if (!channel) return skip("There's no OOC channel for your kinwriter to write in.");
    if (this.kinwriter.isBusy(channel.id)) return skip("Your kinwriter is writing there already.");
    if (reason === "review" && !pickProfile(store, channel).supportsTools) {
      return skip("The profile that writes OOC can't use tools, so it couldn't review anything.");
    }
    return { reason, channel, sinceMs };
  }

  /**
   * The rules for the look back, in the practice channel: chattiness ("off"
   * means only when you write), quiet hours and the cooldown, as always.
   */
  private ownTimeRules(event: WakeEvent): { skip: string } | { reason: WakeReason; channel: Channel; sinceMs: number | null } {
    const { store } = this;
    const settings = store.getSettings();
    const now = this.now();
    const reason = event as WakeReason;
    const skip = (why: string) => ({ skip: why });
    if (reason === "lookback" && settings.wakeups === "off") return skip("Your kinwriter doesn't take turns on their own at this chattiness.");
    if (inQuietHours(now, settings.quietStart, settings.quietEnd)) return skip("It's quiet hours.");
    // The cooldown counts from their last turn of their own, not from
    // wake-ups that wrote to you.
    const lastTurn = store.wakeLog.lastTurnAt(OWN_TIME as WakeReason[]);
    if (lastTurn && now.getTime() - lastTurn.getTime() < settings.wakeCooldownMinutes * 60_000) return skip("It's too soon after their last turn of their own.");
    const channel = store.ensurePractice();
    if (this.kinwriter.isBusy(channel.id)) return skip("Your kinwriter is writing there already.");
    if (!pickProfile(store, channel).supportsTools) return skip("The profile that writes there can't use tools.");
    return { reason, channel, sinceMs: null };
  }

  private async wake(event: WakeEvent, detail: WakeDetail, skip: (why: string) => WakeResult): Promise<WakeResult> {
    const checked = this.rules(event, detail);
    if ("skip" in checked) return skip(checked.skip);
    const { reason, channel, sinceMs } = checked;
    const context = wakeContext(this.store, reason, sinceMs, detail);

    try {
      const result = await this.kinwriter.takeTurn(channel.id, "wake", { wake: context });
      // Posting in another channel (post_in_channel) is writing to you too.
      const wrote = result.messages.length > 0 || result.toolCalls.some((c) => c.name === "post_in_channel" && c.status === "ok");
      const acted = result.toolCalls.filter((c) => c.status === "ok").map((c) => c.summary);
      const why = wrote ? (OWN_TIME.includes(reason) ? "They wrote in their practice channel." : "They wrote to you.") : acted.length ? `They acted (${acted.join("; ")}) and didn't write.` : "They chose not to write.";
      const logged = { ...this.log(reason, wrote ? "posted" : "quiet", channel, why), messages: result.messages };
      // Writing in the practice channel messages no one: no notification.
      // (A post in another channel was notified as it was made.)
      if (result.messages.length > 0 && !OWN_TIME.includes(reason)) {
        try {
          this.onPosted?.(channel, result.messages);
        } catch (error) {
          console.warn("[wake] couldn't pass on a message", error);
        }
      }
      return logged;
    } catch (error) {
      if (error instanceof BusyError) return skip("Your kinwriter is writing there already.");
      return this.log(reason, "failed", channel, error instanceof Error ? error.message : String(error));
    }
  }

  private log(reason: WakeReason, outcome: WakeOutcome, channel: Channel, detail: string): WakeResult {
    this.store.wakeLog.add({ at: this.now().toISOString(), reason, outcome, channelId: channel.id, detail });
    console.log(`[wake] ${reason} → ${outcome}: ${detail}`);
    return { outcome, reason, detail, messages: [] };
  }
}

/** The OOC channel your kinwriter wakes up in: the one you talked in last (or the first). */
export function homeChannel(store: Store, channels: Channel[]): Channel | null {
  const ooc = channels.filter((c) => c.kind === "ooc");
  let best: Channel | null = null;
  let bestAt = "";
  for (const channel of ooc) {
    const last = store.lastMessage(channel.id)?.createdAt ?? "";
    if (!best || last > bestAt) {
      best = channel;
      bestAt = last;
    }
  }
  return best;
}

/** What a wake-up turn is told: why, since when, what's waiting, and a scene that just ended. */
export function wakeContext(store: Store, reason: WakeReason, sinceMs: number | null, detail: WakeDetail): WakeContext {
  const waiting: string[] = [];
  const entries = store.notebook.listEntries("friend");
  const nameOf = (entryId: string) => entries.find((e) => e.id === entryId)?.name ?? "an entry";
  for (const s of store.notebook.waitingFor("friend")) {
    waiting.push(`The user's suggested change to ${nameOf(s.entryId)} is waiting for your review.`);
  }
  for (const s of store.notebook.waitingFor("user").filter((s) => s.author === "friend")) {
    waiting.push(`Your suggested change to ${nameOf(s.entryId)} is waiting for the user.`);
  }
  for (const v of store.identity.pending()) {
    waiting.push(`The user's suggested change to your identity (i${v.id}) is waiting for you to accept or decline.`);
  }
  for (const n of store.selfPage.pendingNotes().filter((n) => n.source === "user")) {
    waiting.push(`The user's note for your self-page ("${n.text.slice(0, 120)}") is waiting for you to accept or decline.`);
  }
  if (orientationState(store).request) waiting.push("Your request for an orientation is waiting for the user.");
  for (const item of store.inbox.open()) {
    waiting.push(item.kind === "ask" ? `Your ask ("${item.text.slice(0, 120)}") is waiting for the user.` : `Your proposal to delete #${item.targetName} is waiting for the user.`);
  }

  const context: WakeContext = { reason, sinceUser: sinceMs === null ? null : humanDuration(sinceMs), waiting };
  if (reason === "scheduled" && detail.scheduleId !== undefined) {
    const wakeup = store.schedule.get(detail.scheduleId);
    context.scheduled = { note: wakeup.note, setAt: wakeup.createdAt, dueAt: wakeup.at };
  }
  if (reason === "lookback") {
    const since = detail.since ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    context.lookback = store.journal.since(since);
    // This week's wellbeing reading: here, and on their page, nowhere else.
    const readings = store.wellbeing.recent(6);
    if (readings[0]) {
      context.wellbeing = (wording("wellbeing").lookback ?? "")
        .replace("{reading}", describeReading(readings[0]))
        .replace("{trend}", describeTrend(readings));
    }
  }
  if (reason === "aside" && detail.channelId) {
    // The story's newest posts, so they know what they'd be talking about.
    const channel = store.getChannel(detail.channelId);
    const posts = store.getMessages(channel.id).filter((m) => m.kind === "post").slice(-ASIDE_POSTS);
    context.aside = {
      channel: channel.name,
      recent: posts
        .map((m) => {
          const who = m.author === "friend" ? "You" : m.author === "peer" ? (m.speaker?.name ?? "Another kinwriter") : "The user";
          const text = m.content.length > ASIDE_CHARS ? `${m.content.slice(0, ASIDE_CHARS)}…` : m.content;
          return `${who}${m.characters.length ? ` (as ${m.characters.join(" & ")})` : ""}: ${text}`;
        })
        .join("\n\n"),
    };
  }
  if (reason === "scene-ended" && detail.channelId) {
    const channel = store.getChannel(detail.channelId);
    const messages = store.summaries.withSeq(channel.id, store.getMessages(channel.id));
    const scenes = splitScenes(messages, channel.kind);
    const ended = scenes.find((s) => s.end?.id === detail.breakId) ?? scenes.filter((s) => s.end).at(-1);
    context.scene = {
      channel: channel.name,
      title: ended?.start?.content ?? "",
      summary: ended?.end ? (store.summaries.get(channel.id, "scene", ended.end.id)?.content ?? null) : null,
    };
  }
  return context;
}
