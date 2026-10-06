/**
 * Rewrites: suggesting new words for part of your kinwriter's message (the
 * editing lesson's middle rung, and any time after).
 *
 * You highlight part of one of their messages and write what you'd put
 * instead. It waits for them, with every other suggestion ("Waiting for
 * your review" in their prompt). They accept or decline each one on its
 * own (`review_rewrite`); accepting puts your words in, as their own edit,
 * with the earlier version kept in the message's history. Once every
 * rewrite on a message is answered, they're invited to look over them
 * together and keep a craft note for themselves ("I lean on this phrase"),
 * never a record of mistakes.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";

export type RewriteStatus = "pending" | "accepted" | "declined" | "withdrawn";

export interface Rewrite {
  id: string;
  messageId: string;
  quote: string;
  replacement: string;
  status: RewriteStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface Row {
  id: string;
  message_id: string;
  quote: string;
  replacement: string;
  status: RewriteStatus;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

const toRewrite = (r: Row): Rewrite => ({
  id: r.id,
  messageId: r.message_id,
  quote: r.quote,
  replacement: r.replacement,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

export class Rewrites {
  constructor(private readonly db: Database) {}

  /** You suggest new words for part of a message. */
  suggest(messageId: string, quote: string, replacement: string): Rewrite {
    if (!quote.trim()) throw new ValidationError("Highlight the words you'd change.");
    if (quote.length > 2000 || replacement.length > 4000) throw new ValidationError("That's too long for one rewrite.");
    const id = crypto.randomUUID();
    this.db
      .query("INSERT INTO message_rewrites (id, message_id, quote, replacement, created_at) VALUES ($id, $messageId, $quote, $replacement, $now)")
      .run({ id, messageId, quote: quote.trim(), replacement: replacement.trim(), now: new Date().toISOString() });
    return this.get(id);
  }

  get(id: string): Rewrite {
    const row = this.db.query("SELECT * FROM message_rewrites WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("rewrite");
    return toRewrite(row);
  }

  /** By the short id your kinwriter uses (the first 8 characters). */
  find(short: string): Rewrite {
    const rows = this.db.query("SELECT * FROM message_rewrites WHERE id LIKE $prefix").all({ prefix: `${short.trim()}%` }) as Row[];
    if (rows.length !== 1) throw new NotFoundError("rewrite");
    return toRewrite(rows[0]!);
  }

  /** Every rewrite on the messages of a channel, oldest first. */
  forChannel(channelId: string): Rewrite[] {
    return (
      this.db
        .query("SELECT r.* FROM message_rewrites r JOIN messages m ON m.id = r.message_id WHERE m.channel_id = $channelId ORDER BY r.created_at")
        .all({ channelId }) as Row[]
    ).map(toRewrite);
  }

  forMessage(messageId: string): Rewrite[] {
    return (this.db.query("SELECT * FROM message_rewrites WHERE message_id = $messageId ORDER BY created_at").all({ messageId }) as Row[]).map(toRewrite);
  }

  /** Waiting for your kinwriter. */
  pending(): Rewrite[] {
    return (
      this.db
        .query("SELECT r.* FROM message_rewrites r JOIN messages m ON m.id = r.message_id WHERE r.status = 'pending' AND m.deleted_at IS NULL ORDER BY r.created_at")
        .all() as Row[]
    ).map(toRewrite);
  }

  /** Their answer. Applying an accepted one is the caller's (it edits the message). */
  resolve(id: string, status: "accepted" | "declined" | "withdrawn", note?: string | null): Rewrite {
    const rewrite = this.get(id);
    if (rewrite.status !== "pending") throw new ValidationError(`That rewrite was already ${rewrite.status}.`);
    this.db
      .query("UPDATE message_rewrites SET status = $status, note = $note, resolved_at = $now WHERE id = $id")
      .run({ id, status, note: note?.trim() || null, now: new Date().toISOString() });
    return this.get(id);
  }
}

/**
 * The message's text with the rewrite applied: the quoted words replaced,
 * once. Formatting marks (*, _) are ignored when finding them, since the
 * highlight was made on the shown text. Null if the words aren't there
 * any more (the message changed since).
 */
export function applyRewrite(content: string, quote: string, replacement: string): string | null {
  const at = content.indexOf(quote);
  if (at >= 0) return content.slice(0, at) + replacement + content.slice(at + quote.length);
  // Match while skipping formatting marks in the message.
  const plain: number[] = [];
  let text = "";
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "*" || content[i] === "_") continue;
    plain.push(i);
    text += content[i];
  }
  const found = text.indexOf(quote.replace(/[*_]/g, ""));
  if (found < 0) return null;
  let start = plain[found]!;
  let end = plain[found + quote.replace(/[*_]/g, "").length - 1]! + 1;
  // Don't leave half a pair of formatting marks behind: an odd number
  // inside the replaced words takes its partner, just outside, with it.
  for (const mark of ["*", "_"]) {
    const inside = [...content.slice(start, end)].filter((c) => c === mark).length;
    if (inside % 2 === 0) continue;
    if (content[start - 1] === mark) start -= 1;
    else if (content[end] === mark) end += 1;
  }
  return content.slice(0, start) + replacement + content.slice(end);
}
