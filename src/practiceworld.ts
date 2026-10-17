/**
 * The practice world: the notes pinned to your kinwriter's practice channel,
 * the practice scene's stand-in partner and posts, and, on a brand-new
 * server, the example character in #story.
 *
 * These used to be fixed (a lighthouse keeper, a harbour town, a ferry
 * mechanic), and everything your kinwriter made in orientation drifted
 * toward them: every practice scene was a lighthouse keeper. Now a world is
 * written fresh for each orientation, from who they are (their identity and
 * tastes), by the profile that writes summaries (the cheap one). As with
 * the old "Surprise me" found, asking a model for "a setting" gets the same
 * few every time, so a few ingredients are rolled at random first
 * (`rollWorldSeeds`); the wording, with a list of stock premises to stay
 * away from, is in defaults/practice-world.md.
 *
 * If no world can be written (no model reachable, or a reply that can't be
 * read), the built-in one is used: defaults/practice.md and
 * defaults/practice-scene.md.
 */

import { extractJson } from "./json.ts";
import type { profileRequest } from "./kinwriter.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { Store } from "./store.ts";
import type { EntryField } from "./types.ts";
import { fill, wording } from "./wording.ts";

const GENRES = [
  "cozy mystery", "gothic horror", "heist caper", "slow-burn romance", "political intrigue", "survival", "folk fantasy",
  "science fiction", "noir", "comedy of manners", "ghost story", "weird western", "solarpunk", "workplace drama",
  "fairy tale retold", "cosmic horror", "sports drama", "court intrigue", "found-family adventure", "small-town secrets",
];
const SETTINGS = [
  "a night market under a railway viaduct", "a hilltop monastery that brews beer", "a generation ship's hydroponics deck",
  "a desert caravan stop", "a snowed-in ski lodge", "a travelling circus", "a city archive", "a mountain observatory",
  "a border checkpoint", "a crumbling opera house", "an orbital hotel", "a salt-flat racing town",
  "a botanical garden after hours", "a boarding school", "a jungle research station", "a frontier mining camp",
  "a dying shopping mall", "a vineyard at harvest", "a subway maintenance depot", "a royal kitchen",
  "a tea estate in the hills", "a radio station at 3 a.m.", "a high-rise under construction", "a roadside diner on a long highway",
  "a university's sealed-off wing", "a city of airships", "a village built on a glacier", "a casino in an old train station",
];
const ERAS = [
  "present day", "near future", "far future", "the 1920s", "Victorian", "medieval", "the Bronze Age", "the 1980s",
  "the 1950s", "Renaissance", "an invented world of its own", "after a collapse", "Edo-period Japan, loosely", "the Wild West",
  "the 1970s", "ancient Rome, loosely",
];
const TROUBLES = [
  "a debt coming due", "a missing heir", "a forged letter", "a broken promise", "a rival's sudden return", "a cursed object",
  "an inheritance dispute", "a lie that's about to come out", "a sickness no one will name", "a stolen recipe",
  "a contest with impossible stakes", "an election", "an engagement nobody wants", "a door that shouldn't be opened",
  "a secret identity", "a deal with something old", "a body that won't stay buried", "a promise made to the wrong person",
];

const ROLES = [
  "a night-shift pharmacist", "a disgraced pastry chef", "a court stenographer", "a beekeeper", "a locksmith's apprentice",
  "a retired stunt double", "a tax collector", "a museum night guard", "a wedding singer", "a falconer", "a typesetter",
  "a tram driver", "an undertaker", "a perfumer", "a horse trainer", "a late-night radio host", "a diplomat's translator",
  "a glassblower", "a debt collector", "a schoolteacher", "a bookbinder", "a mountain guide", "a street magician",
  "a chess hustler", "an archivist", "a forger", "a field nurse", "a jockey", "a palace gardener", "a tattoo artist",
  "a midwife", "a tailor", "a stage manager", "a bounty hunter", "a monk who's lost their faith", "a war photographer",
  "a vintner", "a piano tuner", "a toxicologist", "a sommelier", "a census taker", "a puppeteer", "a blacksmith",
];
const WANTS = [
  "to be forgiven by someone who's dead", "to win something they don't deserve", "a quiet life they keep getting dragged out of",
  "to pay off a debt before anyone notices", "revenge they're no longer sure about", "to be taken seriously",
  "to keep a promise that's become dangerous", "to leave town for good", "to protect someone who doesn't want protecting",
  "to finish what their mentor started", "money, honestly", "to be remembered", "to undo one specific mistake",
  "to be left alone", "to prove a rumour about them wrong", "to get back something that was stolen",
];

/** A starting point for the character your kinwriter makes in orientation, rolled so it isn't the model's first idea. */
export function rollCharacterSeed(random: () => number = Math.random): string {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
  return `${pick(ROLES)} who wants ${pick(WANTS)}`;
}

/**
 * Words that put a world at sea. Models drift there on their own (a
 * lighthouse keeper, then a dockworker), so a world that uses any of them is
 * written again with new ingredients. Never sent to a model: naming them
 * only pulls it back.
 */
const AT_SEA = /\b(lighthouses?|harbou?rs?|docks?|dockworkers?|dockside|piers?|wharf|wharves|quays?|sailors?|sailing|ships?|shipwrecks?|seas?|seaside|seafaring|oceans?|tides?|coast|coastal|shores?|ashore|ferry|ferries|boats?|fishermen|fisherman|fishing|nautical|mariners?|marina|lagoon|islands?)\b/i;

/** Whether a world is at sea, by its words. */
export function atSea(world: PracticeWorld): boolean {
  return AT_SEA.test(JSON.stringify({ notes: world.notes, character: world.character, scene: world.scene }));
}

/** The rolled ingredients of a world. */
export interface WorldSeeds {
  genre: string;
  setting: string;
  era: string;
  trouble: string;
}

/** Pick the ingredients at random. */
export function rollWorldSeeds(random: () => number = Math.random): WorldSeeds {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
  return { genre: pick(GENRES), setting: pick(SETTINGS), era: pick(ERAS), trouble: pick(TROUBLES) };
}

/** A notebook entry the world starts with. */
export interface WorldEntry {
  kind: "character" | "lore";
  name: string;
  fields: EntryField[];
}

export interface PracticeWorld {
  /** The notes pinned to the practice channel. */
  notes: WorldEntry[];
  /** Someone your kinwriter could play: the example character on a brand-new server. */
  character: WorldEntry | null;
  /** The practice scene (on their own): its channel's name, the stand-in partner, and their posts. */
  scene: { channel: string; partnerName: string; partnerAbout: string; posts: string[] };
  /** Whether it was written for them (false: the built-in one). */
  generated: boolean;
}

// ----------------------------------------------------------- the built-in one

/** `Label: text` lines as fields. */
function fieldsOf(body: string): EntryField[] {
  return body
    .split("\n")
    .map((line) => line.match(/^\s*([^:\n]{1,30}):\s*(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ label: m[1]!.trim(), value: m[2]!.trim() }));
}

/** The built-in world, from defaults/practice.md and defaults/practice-scene.md. */
export function builtInWorld(): PracticeWorld {
  const notes: WorldEntry[] = [];
  for (const [heading, body] of Object.entries(wording("practice"))) {
    const match = heading.match(/^(.+?)\s*\((character|lore)\)\s*$/);
    if (match) notes.push({ kind: match[2] as "character" | "lore", name: match[1]!.trim(), fields: fieldsOf(body) });
  }
  const scene = wording("practice-scene");
  const posts: string[] = [];
  for (let n = 1; scene[`post-${n}`]?.trim(); n++) posts.push(scene[`post-${n}`]!.trim());
  return {
    notes,
    character: null,
    scene: {
      channel: scene.channel?.trim() || "practice-scene",
      partnerName: scene["partner-name"]?.trim() || "Your partner",
      partnerAbout: scene["partner-about"]?.trim() ?? "",
      posts,
    },
    generated: false,
  };
}

// ------------------------------------------------------------- writing one

/** Who the world is for. */
export interface WorldFor {
  name: string;
  identity: string;
  tastes: string;
}

/**
 * Ask the model for a world, from who they are and the rolled seeds. A
 * world at sea is written again with new seeds, once. Throws if the reply
 * can't be read, or it's still at sea.
 */
async function writePracticeWorld(
  api: ApiOptions,
  request: ReturnType<typeof profileRequest>,
  who: WorldFor,
  seeds: WorldSeeds = rollWorldSeeds(),
): Promise<PracticeWorld> {
  const world = await askForWorld(api, request, who, seeds);
  if (!atSea(world)) return world;
  const again = await askForWorld(api, request, who, rollWorldSeeds());
  if (atSea(again)) throw new Error("The model set both worlds at sea.");
  return again;
}

async function askForWorld(api: ApiOptions, request: ReturnType<typeof profileRequest>, who: WorldFor, seeds: WorldSeeds): Promise<PracticeWorld> {
  const words = wording("practice-world");
  const response = await createChatCompletion(api, {
    ...request,
    temperature: Math.max(request.temperature, 0.9),
    maxTokens: Math.max(request.maxTokens, 1600),
    messages: [
      {
        role: "system",
        content: fill(words.system ?? "", {
          name: who.name,
          identity: who.identity.trim() || "(not written yet)",
          tastes: who.tastes.trim() || "(not written yet)",
          ...seeds,
        }),
      },
      { role: "user", content: words.user ?? "Make the world." },
    ],
  });
  return readWorld(extractJson(response.content));
}

/** The model's JSON as a world. Throws, in plain words, if what's needed isn't there. */
export function readWorld(json: unknown): PracticeWorld {
  const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const text = (value: unknown, max = 2000) => (typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "");
  const object = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  /** An entry from an object: its name, and every other non-empty key as a field, labelled like "Personality". */
  const entry = (kind: WorldEntry["kind"], value: unknown): WorldEntry | null => {
    const o = object(value);
    const name = text(o.name, 100);
    if (!name) return null;
    const fields = Object.entries(o)
      .filter(([key]) => key !== "name")
      // Within the notebook's limits (labels of 60 characters, 50 fields), so saving it can't fail.
      .map(([key, v]) => ({ label: (key.charAt(0).toUpperCase() + key.slice(1)).slice(0, 60).trim(), value: text(v) }))
      .filter((f) => f.label && f.value)
      .slice(0, 50);
    return { kind, name, fields };
  };
  const notes = [entry("lore", data.place), entry("character", data.local), entry("lore", data.event)].filter((e): e is WorldEntry => e !== null);
  const partner = object(data.partner);
  const posts = Array.isArray(data.posts) ? data.posts.map((p) => text(p, 4000)).filter(Boolean).slice(0, 5) : [];
  const partnerName = text(partner.name, 100);
  if (notes.length === 0 || !partnerName || posts.length < 2) {
    throw new Error("The model's answer didn't have the notes, a partner and two posts.");
  }
  const channel = text(data.channel, 60).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    notes,
    character: entry("character", data.character),
    scene: { channel: channel || "practice-scene", partnerName, partnerAbout: text(partner.about), posts },
    generated: true,
  };
}

// ------------------------------------------------------------- the one in use

const WORLD = "practice.world";
const EXAMPLE_PENDING = "example.pending";

/** The world in use: the last one written for them, or the built-in one. */
export function practiceWorld(store: Store): PracticeWorld {
  const saved = store.appState.get(WORLD);
  if (saved) {
    try {
      return JSON.parse(saved) as PracticeWorld;
    } catch {
      // Unreadable: the built-in one.
    }
  }
  return builtInWorld();
}

/** Put the world's notes in the Practice folder, pinned to the practice channel (replacing what was there), and remember it. */
function useWorld(store: Store, world: PracticeWorld): void {
  // All at once: if a note can't be saved, the old ones are still there.
  store.db.transaction(() => {
    const channel = store.ensurePractice();
    const folder = store.notebook.practiceFolder()!;
    for (const entry of store.notebook.listEntries("kinwriter", true)) {
      if (entry.folderId === folder.id) store.notebook.deleteEntry("kinwriter", entry.id);
    }
    for (const note of world.notes) {
      const entry = store.notebook.createEntry("kinwriter", { kind: note.kind, name: note.name, fields: note.fields });
      store.notebook.updateEntrySettings("kinwriter", entry.id, { folderId: folder.id });
      store.notebook.pin("kinwriter", channel.id, entry.id);
    }
    store.appState.set(WORLD, JSON.stringify(world));
  })();
}

/** Who the world is for, from their settings and identity. */
function worldFor(store: Store): WorldFor {
  const current = store.identity.current();
  return { name: store.getSettings().kinwriterName, identity: current?.identity ?? store.getSettings().kinwriterPrompt, tastes: current?.tastes ?? "" };
}

/**
 * A fresh world for them, put to use. If it can't be written, the built-in
 * one is used, and `error` says why.
 */
export async function freshWorld(
  store: Store,
  api: ApiOptions,
  request: ReturnType<typeof profileRequest>,
  seeds?: WorldSeeds,
): Promise<{ world: PracticeWorld; error?: string }> {
  let world: PracticeWorld;
  let error: string | undefined;
  try {
    world = await writePracticeWorld(api, request, worldFor(store), seeds);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    world = builtInWorld();
  }
  useWorld(store, world);
  return error ? { world, error } : { world };
}

// ------------------------------------------------------- the example character

/** A brand-new server: its #story waits for an example character written for them. */
export function awaitExampleCharacter(store: Store, channelId: string): void {
  store.appState.set(EXAMPLE_PENDING, channelId);
}

/** The story channel waiting for its example character, if one is. */
export function exampleCharacterPending(store: Store): string | null {
  return store.appState.get(EXAMPLE_PENDING);
}

/**
 * Give #story its example character, from a world written for them. Only if
 * the channel is still there and its cast still empty: otherwise there's
 * nothing to do. Either way, it's no longer waiting.
 */
export function addExampleCharacter(store: Store, world: PracticeWorld): void {
  const channelId = exampleCharacterPending(store);
  if (!channelId) return;
  if (world.character && store.hasChannel(channelId) && store.notebook.castFor("user", channelId).length === 0) {
    const entry = store.notebook.createEntry("user", { kind: "character", owner: "kinwriter", name: world.character.name, fields: world.character.fields });
    store.notebook.pin("user", channelId, entry.id);
  }
  store.appState.set(EXAMPLE_PENDING, null);
}
