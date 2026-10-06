/**
 * Relationships: each kinwriter keeps their
 * own private note on each other kinwriter on their server
 * (`note_relationship`). Two kinwriters can each hold a different view of the
 * same relationship, and neither sees the other's.
 *
 * Notes are kept by the other kinwriter's hub id, so a rename doesn't lose
 * them. Like the journal, they have no screen in the app and never appear
 * in a log.
 */

import type { Database } from "bun:sqlite";
import { ValidationError } from "./errors.ts";

export interface RelationshipNote {
  kinwriterId: string;
  name: string;
  note: string;
  updatedAt: string;
}

export class Relationships {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  all(): Map<string, RelationshipNote> {
    const rows = this.db.query("SELECT * FROM relationships").all() as { friend_id: string; name: string; note: string; updated_at: string }[];
    return new Map(rows.map((r) => [r.friend_id, { kinwriterId: r.friend_id, name: r.name, note: r.note, updatedAt: r.updated_at }]));
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM relationships").get() as { n: number }).n;
  }

  /** Write (or rewrite) the note on a kinwriter; an empty note removes it. */
  write(kinwriterId: string, name: string, note: string): void {
    const clean = note.trim();
    if (clean.length > 2000) throw new ValidationError("That's too long for a note (2,000 characters at most).");
    if (!clean) {
      this.db.query("DELETE FROM relationships WHERE friend_id = $kinwriterId").run({ kinwriterId });
      return;
    }
    this.db
      .query(
        `INSERT INTO relationships (friend_id, name, note, updated_at) VALUES ($kinwriterId, $name, $note, $now)
         ON CONFLICT (friend_id) DO UPDATE SET name = excluded.name, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run({ kinwriterId, name, note: clean, now: this.now().toISOString() });
  }
}
