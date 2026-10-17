/**
 * Your kinwriter's identity: who they are, and their tastes. It belongs to
 * them.
 *
 * It's written when they're made, by "Surprise me" or by you. After that:
 *
 *   - **They revise it** with `revise_identity`. Every version is kept.
 *   - **Your edits are suggestions.** Changing it in the app sends them a
 *     suggestion, which they accept or decline on their next turn (with a
 *     reply, if they like). The same idea as notebook suggestions.
 *   - **Everyone can see the changelog**, with who wrote each version.
 *
 * The **tastes** section is what they love, what bores them, and what
 * they'd never write. It's seeded when they're made and grows with them:
 * it's their defence against drifting into agreeing with everything.
 *
 * The current identity is also kept in the `kinwriterPrompt` setting, so the
 * rest of the app (the kinwriter menu, copying settings to a new kinwriter) keeps
 * reading it from one place.
 */

import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "./errors.ts";
import type { Author } from "./types.ts";

export type IdentityStatus = "accepted" | "pending" | "declined" | "withdrawn";

export interface IdentityVersion {
  id: number;
  identity: string;
  tastes: string;
  /** Who wrote this version. */
  author: Author;
  /** Why, in their words (or yours, for a suggestion). */
  note: string;
  status: IdentityStatus;
  /** Your kinwriter's reply to a suggestion of yours. */
  reply: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface Row {
  id: number;
  identity: string;
  tastes: string;
  author: Author;
  note: string;
  status: IdentityStatus;
  reply: string | null;
  created_at: string;
  resolved_at: string | null;
}

const toVersion = (r: Row): IdentityVersion => ({
  id: r.id,
  identity: r.identity,
  tastes: r.tastes,
  author: r.author,
  note: r.note,
  status: r.status,
  reply: r.reply,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

/** Longest identity or tastes, in characters (the same as the settings allowed before identities had versions). */
export const IDENTITY_LIMIT = 100_000;

function text(value: unknown, field: string, limit = IDENTITY_LIMIT): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`);
  if (value.length > limit) throw new ValidationError(`${field} is too long (${limit} characters at most).`);
  return value.trim();
}

export class Identity {
  constructor(
    private readonly db: Database,
    /** Keeps the `kinwriterPrompt` setting in step with the current identity. */
    private readonly mirror: (identity: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The current identity: the newest accepted version (`null` before the first). */
  current(): IdentityVersion | null {
    const row = this.db.query("SELECT * FROM identity_versions WHERE status = 'accepted' ORDER BY id DESC LIMIT 1").get() as Row | null;
    return row ? toVersion(row) : null;
  }

  /** Every version and suggestion, oldest first: the changelog. */
  history(): IdentityVersion[] {
    return (this.db.query("SELECT * FROM identity_versions ORDER BY id").all() as Row[]).map(toVersion);
  }

  get(id: number): IdentityVersion {
    const row = this.db.query("SELECT * FROM identity_versions WHERE id = $id").get({ id }) as Row | null;
    if (!row) throw new NotFoundError("identity version");
    return toVersion(row);
  }

  /**
   * Where it starts: the identity your kinwriter was made with (or already
   * had, before identities had versions). Replaces anything there (only
   * used when they're made, or first opened by this version). What's
   * already saved is kept whatever its length: refusing it would stop the
   * app from starting.
   */
  begin(identity: string, tastes: string): IdentityVersion {
    this.db.transaction(() => {
      this.db.query("DELETE FROM identity_versions").run();
      this.insert({ identity: text(identity, "identity", Infinity), tastes: text(tastes, "tastes", Infinity), author: "user", note: "Who they were made as.", status: "accepted" });
    })();
    this.mirror(identity.trim());
    return this.current()!;
  }

  /** Your kinwriter rewrites their identity, their tastes, or both. */
  revise(change: { identity?: string; tastes?: string; note?: string }): IdentityVersion {
    const now = this.current();
    const identity = change.identity !== undefined ? text(change.identity, "identity") : (now?.identity ?? "");
    const tastes = change.tastes !== undefined ? text(change.tastes, "tastes") : (now?.tastes ?? "");
    if (!identity) throw new ValidationError("Your identity can't be empty.");
    if (now && identity === now.identity && tastes === now.tastes) throw new ValidationError("That's the same as your current identity.");
    const id = this.insert({ identity, tastes, author: "kinwriter", note: (change.note ?? "").trim().slice(0, 1000), status: "accepted" });
    this.mirror(identity);
    return this.get(id);
  }

  /** You suggest a change. Your kinwriter accepts or declines it. */
  suggest(change: { identity?: string; tastes?: string; note?: string }): IdentityVersion {
    const now = this.current();
    const identity = change.identity !== undefined ? text(change.identity, "identity") : (now?.identity ?? "");
    const tastes = change.tastes !== undefined ? text(change.tastes, "tastes") : (now?.tastes ?? "");
    if (!identity) throw new ValidationError("An identity can't be empty.");
    if (now && identity === now.identity && tastes === now.tastes) throw new ValidationError("That's the same as their current identity.");
    const id = this.insert({ identity, tastes, author: "user", note: (change.note ?? "").trim().slice(0, 1000), status: "pending" });
    return this.get(id);
  }

  /** Your suggestions waiting for your kinwriter, oldest first. */
  pending(): IdentityVersion[] {
    return (this.db.query("SELECT * FROM identity_versions WHERE status = 'pending' ORDER BY id").all() as Row[]).map(toVersion);
  }

  /**
   * Your kinwriter accepts or declines a suggestion, with an optional reply.
   * Accepting makes it their current identity.
   */
  review(id: number, decision: "accept" | "decline", reply?: string): IdentityVersion {
    const version = this.get(id);
    if (version.status !== "pending") throw new ValidationError("That suggestion has already been dealt with.");
    const now = this.now().toISOString();
    const cleanReply = reply?.trim().slice(0, 1000) || null;
    return this.db.transaction(() => {
      if (decision === "decline") {
        this.db.query("UPDATE identity_versions SET status = 'declined', reply = $reply, resolved_at = $now WHERE id = $id").run({ id, reply: cleanReply, now });
        return this.get(id);
      }
      // A suggestion holds the whole identity and tastes as they were then,
      // with your change. Only the parts you changed are taken, so a
      // revision they made since isn't undone.
      const base = this.currentAt(version);
      const current = this.current();
      const identity = !base || !current || version.identity !== base.identity ? version.identity : current.identity;
      const tastes = !base || !current || version.tastes !== base.tastes ? version.tastes : current.tastes;
      // An accepted suggestion becomes the newest version: it goes to the end.
      const newId = this.insert({ ...version, identity, tastes, status: "accepted" });
      this.db.query("UPDATE identity_versions SET resolved_at = $now, reply = $reply WHERE id = $newId").run({ newId, now, reply: cleanReply });
      this.db.query("DELETE FROM identity_versions WHERE id = $id").run({ id });
      this.mirror(identity);
      return this.get(newId);
    })();
  }

  /**
   * The version that was current when a suggestion was made: the accepted
   * one that most recently became current before it (an accepted
   * suggestion became current when it was accepted, not when written).
   */
  private currentAt(suggestion: IdentityVersion): IdentityVersion | null {
    const row = this.db
      .query(
        `SELECT * FROM identity_versions
          WHERE status = 'accepted' AND (resolved_at IS NULL AND id < $id OR resolved_at <= $at)
          ORDER BY COALESCE(resolved_at, created_at) DESC, id DESC LIMIT 1`,
      )
      .get({ id: suggestion.id, at: suggestion.createdAt }) as Row | null;
    return row ? toVersion(row) : null;
  }

  /** You take a suggestion back before they've reviewed it. */
  withdraw(id: number): void {
    const version = this.get(id);
    if (version.status !== "pending") throw new ValidationError("That suggestion has already been dealt with.");
    this.db.query("UPDATE identity_versions SET status = 'withdrawn', resolved_at = $now WHERE id = $id").run({ id, now: this.now().toISOString() });
  }

  private insert(v: { identity: string; tastes: string; author: Author; note: string; status: IdentityStatus; createdAt?: string }): number {
    const result = this.db
      .query(
        `INSERT INTO identity_versions (identity, tastes, author, note, status, created_at)
         VALUES ($identity, $tastes, $author, $note, $status, $now)`,
      )
      .run({ identity: v.identity, tastes: v.tastes, author: v.author, note: v.note, status: v.status, now: v.createdAt ?? this.now().toISOString() });
    return Number(result.lastInsertRowid);
  }
}
