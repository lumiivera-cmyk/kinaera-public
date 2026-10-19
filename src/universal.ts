/**
 * Universal settings: one Settings menu for every kinwriter.
 *
 * Each kinwriter is a whole app with its own database (src/hub.ts), so each
 * keeps its own copy of the settings and of the connection profiles and
 * roulettes. The hub keeps those copies the same: change a setting, or a
 * profile, while looking at any kinwriter and every kinwriter gets it.
 *
 * Some sections can be set **just for one kinwriter** (their "own"
 * sections): which models write for them, their memory, how they reach out
 * (wake-ups and the heartbeat), and the look (theme, its sliders, and the
 * background picture). While a section is their own, changes to
 * it stay with them, and changes made elsewhere pass them by. Turning it off
 * gives them the shared values again. Which sections are a kinwriter's own
 * is kept in their database (app_state), so it travels with them.
 *
 * Profiles and roulettes are always shared. Each database keeps a copy with
 * the same ids, so assignments mean the same thing everywhere.
 */

import type { Database } from "bun:sqlite";
import type { Settings } from "./types.ts";
import { ASSIGNMENT_KEYS, forgetAssignment } from "./profiles.ts";

/** The Settings menu's sections, by the settings in each. */
export const SETTING_GROUPS = {
  models: ["rpAssignment", "oocAssignment"],
  memory: ["historyLimit", "summaries", "summaryEvery", "summaryAssignment"],
  reaching: ["wakeups", "awayHours", "wakeCooldownMinutes", "asideMinutes", "quietStart", "quietEnd", "heartbeatHours", "heartbeatAssignment"],
  jev: ["decisionModel", "decisionConfidence", "decisionFallback"],
  limits: ["hardLimits"],
  look: ["appTheme", "themeOptions", "appBackground", "backgroundDim"],
} as const satisfies Record<string, readonly (keyof Settings)[]>;

export type SettingGroup = keyof typeof SETTING_GROUPS;

/** The sections a kinwriter can have just for themselves. */
export const OWN_GROUPS: SettingGroup[] = ["models", "memory", "reaching", "look"];

/** Every shared setting. */
export const UNIVERSAL_KEYS: (keyof Settings)[] = Object.values(SETTING_GROUPS).flat();

/** Where a kinwriter's own sections are kept (app_state, as a JSON list). */
const OWN_KEY = "settings.own";

interface HasAppState {
  appState: { get(key: string): string | null; set(key: string, value: string | null): void };
}

/** The sections a kinwriter has just for themselves. */
export function ownGroups(store: HasAppState): SettingGroup[] {
  try {
    const list = JSON.parse(store.appState.get(OWN_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? OWN_GROUPS.filter((g) => list.includes(g)) : [];
  } catch {
    return [];
  }
}

/** Make a section a kinwriter's own, or shared again. */
export function setOwnGroup(store: HasAppState, group: SettingGroup, own: boolean): void {
  const groups = new Set(ownGroups(store));
  if (own) groups.add(group);
  else groups.delete(group);
  const list = OWN_GROUPS.filter((g) => groups.has(g));
  store.appState.set(OWN_KEY, list.length ? JSON.stringify(list) : null);
}

/** The settings that are a kinwriter's own right now (in their own sections). */
export function ownKeys(store: HasAppState): Set<keyof Settings> {
  return new Set(ownGroups(store).flatMap((g) => SETTING_GROUPS[g]));
}

/** Two settings values are the same (they're JSON). */
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Hard limits from several places, together: every line once, in order. None is ever dropped. */
export function unionLines(...texts: string[]): string {
  const lines: string[] = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !lines.includes(trimmed)) lines.push(trimmed);
    }
  }
  return lines.join("\n").slice(0, 4000);
}

// ------------------------------------------------- profiles and roulettes

type Row = Record<string, string | number | null>;

const rows = (db: Database, sql: string) => db.query(sql).all() as Row[];

function upsert(db: Database, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})
     ON CONFLICT (id) DO UPDATE SET ${columns.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
  ).run(Object.fromEntries(columns.map((c) => [c, row[c]!])));
}

/**
 * Make `target`'s profiles and roulettes the same as `source`'s, in place:
 * changed ones are updated (so a kinwriter's notes on a profile stay), new
 * ones added, and ones `source` no longer has deleted, with anything
 * assigned to them going back to the default.
 */
export function syncProfiles(source: Database, target: Database): void {
  const profiles = rows(source, "SELECT * FROM profiles");
  const roulettes = rows(source, "SELECT * FROM roulettes");
  const entries = rows(source, "SELECT * FROM roulette_profiles");
  const keepProfiles = new Set(profiles.map((p) => p.id));
  const keepRoulettes = new Set(roulettes.map((r) => r.id));
  target.transaction(() => {
    for (const { id } of rows(target, "SELECT id FROM roulettes")) {
      if (keepRoulettes.has(id)) continue;
      target.query("DELETE FROM roulettes WHERE id = $id").run({ id: id! });
      forgetAssignment(target, `roulette:${id}`);
    }
    for (const { id } of rows(target, "SELECT id FROM profiles")) {
      if (keepProfiles.has(id)) continue;
      target.query("DELETE FROM profiles WHERE id = $id").run({ id: id! });
      forgetAssignment(target, `profile:${id}`);
    }
    for (const row of profiles) upsert(target, "profiles", row);
    for (const row of roulettes) upsert(target, "roulettes", row);
    target.query("DELETE FROM roulette_profiles").run();
    const insert = target.query("INSERT INTO roulette_profiles (roulette_id, profile_id, weight) VALUES ($roulette_id, $profile_id, $weight)");
    for (const row of entries) insert.run({ roulette_id: row.roulette_id!, profile_id: row.profile_id!, weight: row.weight! });
  })();
}

/** A profile's settings, without where it sits in the list or when it was made. */
const profileContent = (row: Row) => JSON.stringify(Object.entries(row).filter(([key]) => !["position", "created_at", "kinwriter_maker"].includes(key)));

/** Point everything in `db` that used `from` at `to` instead. */
function reassign(db: Database, from: string, to: string): void {
  db.query("UPDATE channels SET assignment = $to WHERE assignment = $from").run({ from, to });
  db.query(`UPDATE settings SET value = $to WHERE key IN (${ASSIGNMENT_KEYS.map((k) => `'${k}'`).join(", ")}) AND value = $from`).run({ from: JSON.stringify(from), to: JSON.stringify(to) });
}

/**
 * Bring a kinwriter's own profiles and roulettes into the shared set (`into`),
 * losing nothing:
 *
 * - one the shared set doesn't have is added to it, as it is;
 * - one with the same id and the same settings is the same profile;
 * - one with the same id but different settings (changed for just this
 *   kinwriter, back when each had their own) is added as a new one, named
 *   with `label` (their name), and everything they had using it is pointed
 *   at the new one, so they keep writing exactly as before.
 *
 * Afterwards `from` still has its old copies: `syncProfiles(into, from)`
 * makes it the same as the shared set.
 */
export function mergeProfiles(into: Database, from: Database, label: string): void {
  const next = (table: string) => (into.query(`SELECT COALESCE(MAX(position) + 1, 0) AS n FROM ${table}`).get() as { n: number }).n;
  const named = (name: unknown) => `${String(name)} (${label})`.slice(0, 100);
  const hasMaker = () => into.query("SELECT 1 FROM profiles WHERE kinwriter_maker = 1").get() !== null;
  const doMerge = () => {
    for (const row of rows(from, "SELECT * FROM profiles ORDER BY position")) {
      const shared = into.query("SELECT * FROM profiles WHERE id = $id").get({ id: row.id! }) as Row | null;
      if (shared && profileContent(shared) === profileContent(row)) continue;
      const added: Row = { ...row, position: next("profiles"), kinwriter_maker: row.kinwriter_maker === 1 && !hasMaker() ? 1 : 0 };
      if (!shared) {
        upsert(into, "profiles", added);
        continue;
      }
      // Changed just for them: theirs becomes a profile of its own.
      const id = crypto.randomUUID();
      upsert(into, "profiles", { ...added, id, name: named(row.name) });
      upsert(from, "profiles", { ...row, id, kinwriter_maker: 0 });
      from.query("UPDATE roulette_profiles SET profile_id = $id WHERE profile_id = $old").run({ id, old: row.id! });
      from.query("UPDATE profile_notes SET profile_id = $id WHERE profile_id = $old").run({ id, old: row.id! });
      reassign(from, `profile:${row.id}`, `profile:${id}`);
    }
    const entriesOf = (db: Database, id: unknown) =>
      JSON.stringify(
        (db.query("SELECT profile_id, weight FROM roulette_profiles WHERE roulette_id = $id ORDER BY profile_id").all({ id: id as string }) as Row[]).map((e) => [
          e.profile_id,
          e.weight,
        ]),
      );
    for (const row of rows(from, "SELECT * FROM roulettes ORDER BY position")) {
      const shared = into.query("SELECT * FROM roulettes WHERE id = $id").get({ id: row.id! }) as Row | null;
      const entries = entriesOf(from, row.id);
      if (shared && shared.name === row.name && entriesOf(into, row.id) === entries) continue;
      const id = shared ? crypto.randomUUID() : (row.id as string);
      upsert(into, "roulettes", { ...row, id, name: shared ? named(row.name) : row.name!, position: next("roulettes") });
      if (shared) {
        upsert(from, "roulettes", { ...row, id });
        from.query("UPDATE roulette_profiles SET roulette_id = $id WHERE roulette_id = $old").run({ id, old: row.id! });
        reassign(from, `roulette:${row.id}`, `roulette:${id}`);
      }
      const insert = into.query("INSERT OR REPLACE INTO roulette_profiles (roulette_id, profile_id, weight) VALUES ($r, $p, $w)");
      for (const e of from.query("SELECT profile_id, weight FROM roulette_profiles WHERE roulette_id = $id").all({ id }) as Row[]) {
        insert.run({ r: id, p: e.profile_id!, w: e.weight! });
      }
    }
  };
  into.transaction(() => from.transaction(doMerge)())();
}
