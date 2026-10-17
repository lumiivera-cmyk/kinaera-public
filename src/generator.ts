/**
 * The seed generator (design/kinwriter-generation/spec.md, "Generator
 * prompt"): one prompt-assembly function and one model call.
 *
 *   1. `buildSeedPrompt` fills every "Surprise me" category at random (a
 *      category with several picks, like personality, keeps them all), then
 *      rolls one pocket for each tag that has them (unless you chose one),
 *      and records what chance picked. It assembles the user message: your
 *      guidance first (so it frames the rest), then each tag's fragment
 *      without its Pockets section, and the chosen or rolled pocket's
 *      bullets under "This person's corner". The system prompt is
 *      `system` in defaults/generator.md, with your edits (Settings → Prompts).
 *   2. `generateSeed` sends one call, with the profile marked "Use for
 *      creating kinwriters" (or the default profile; never a roulette), with
 *      its own samplers and reasoning setting.
 *   3. The reply is parsed: the model's Working notes are dropped, then the
 *      `name:` and `pronouns:` lines, then the headings. The header is built
 *      here: the model never writes `id`,
 *      `source`, `tags`, `rolled`, `pockets`, `model`, `created` or
 *      `seed_version`.
 *   4. It's checked (src/seeds.ts). On a failure, it tries once more with
 *      the same inputs; a second failure is a readable error.
 *
 * "Generate from idea" uses the same pipeline with your words as the user
 * guidance, and any tags you attached. Jev reads your idea for tags it
 * obviously suggests in the categories you left open; if you attached none
 * and none stand out, one to three tags are rolled, and everything else
 * comes from your words alone (`ideaTags`).
 *
 * Dev mode keeps the last generation (`lastGeneration`): the assembled
 * prompt, and each attempt's raw reply with what it failed.
 */

import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { profileRequest } from "./kinwriter.ts";
import type { Decider, Question } from "./jev.ts";
import { DOSAGE_WORDS, newSeedId, SEED_HEADINGS, SEED_VERSION, SEED_WORDS, today, validateSeed, writeSeed, type Seed, type SeedProblem, type SeedSource } from "./seeds.ts";
import { allowsMultiple, CATEGORIES, type CategoryId, type Tag } from "./tags.ts";
import type { Profile } from "./types.ts";
import { fill, wording } from "./wording.ts";

/**
 * The generator's instructions: `system` in defaults/generator.md, so they
 * can be tuned without touching code, and edited in Settings → Prompts.
 */
export function generatorSystemPrompt(): string {
  return fill(wording("generator").system ?? "", { headings: SEED_HEADINGS.map((h) => `## ${h}`).join("\n") }).trim();
}

/**
 * What you picked: a tag per category (null: "Surprise me"), and corners
 * you chose. A category that takes several (personality) can be a list;
 * an empty list is "Surprise me" too.
 */
export interface SeedSelection {
  tags: Partial<Record<CategoryId, string | string[] | null>>;
  /**
   * Tags kept from an earlier roll that still count as rolled (Reroll keeps
   * the same tags, chance's included, and only rolls the person again).
   */
  rolledTags?: string[];
  /** Chosen pockets: `{ "social.twitter-2010s": "absurdist" }`. */
  pockets?: Record<string, string>;
  /**
   * What they're called: a random name (the default), a random username
   * (an online handle), or one you typed (`given`).
   */
  naming?: Naming;
}

/** How a seed gets its name. */
export type Naming = { kind: "name" } | { kind: "username" } | { kind: "given"; name: string };

export interface SeedPrompt {
  system: string;
  user: string;
  /** The final tags, in category order. */
  tags: string[];
  /** Which tags and pockets chance picked (`category.slug`, `category.slug#pocket`). */
  rolled: string[];
  /** Every pocket, chosen or rolled. */
  pockets: string[];
  /** The name you gave them, if you did: it goes in the header as it is. */
  name?: string;
}

/** The user message's Name section: none for a random name, since the system prompt already asks for one. */
function namingSection(naming: Naming | undefined): string {
  const words = wording("generator");
  if (naming?.kind === "username") return `# Name\n${words["name-username"] ?? ""}`;
  if (naming?.kind === "given") return `# Name\n${fill(words["name-given"] ?? "", { name: naming.name })}`;
  return "";
}

/** One heading per tag: its category's name in the research notes, and the tag's label. */
function categorySection(category: CategoryId): string {
  return CATEGORIES.find((c) => c.id === category)!.section;
}

/** A fragment's own headings, one level down, so they sit under the tag's. */
const demote = (text: string) => text.replace(/^##(?=\s)/gm, "###");

/**
 * Assemble the generator's call (spec, "User message layout"). `random`
 * returns a number in [0, 1); tests pass their own. With `fill: false`,
 * categories on "Surprise me" are left out instead of rolled (Generate
 * from idea, where your words fill in the rest).
 */
export function buildSeedPrompt(
  allTags: Tag[],
  selection: SeedSelection,
  userGuidance?: string,
  options: { random?: () => number; fill?: boolean } = {},
): SeedPrompt {
  const random = options.random ?? Math.random;
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
  const kept = new Set(selection.rolledTags ?? []);
  const rolled: string[] = [];
  const chosen: Tag[] = [];
  for (const category of CATEGORIES) {
    const options_ = allTags.filter((t) => t.category === category.id);
    if (!options_.length) continue;
    const value = selection.tags[category.id];
    const wanted = (Array.isArray(value) ? value : value ? [value] : []).slice(0, allowsMultiple(category.id) ? undefined : 1);
    const found = [...new Set(wanted)].map((id) => options_.find((t) => t.id === id)).filter((t): t is Tag => Boolean(t));
    if (found.length) {
      // Several in one category (personality) each get a section; the generator blends them.
      for (const tag of found) {
        chosen.push(tag);
        if (kept.has(tag.id)) rolled.push(tag.id);
      }
    } else if (options.fill !== false) {
      // "Surprise me" (or a tag that's gone): chance picks, and it's recorded.
      const tag = pick(options_);
      chosen.push(tag);
      rolled.push(tag.id);
    }
  }
  const pockets: string[] = [];
  const sections: string[] = [];
  for (const tag of chosen) {
    let corner = "";
    if (tag.pockets.length) {
      const wanted = selection.pockets?.[tag.id];
      let pocket = wanted ? tag.pockets.find((p) => p.slug === wanted) : undefined;
      if (!pocket) {
        pocket = pick(tag.pockets);
        rolled.push(`${tag.id}#${pocket.slug}`);
      }
      pockets.push(`${tag.id}#${pocket.slug}`);
      corner = `\n\n### This person's corner\n${pocket.bullets.map((b) => `- ${b}`).join("\n")}`;
    }
    sections.push(`## ${categorySection(tag.category)}: ${tag.label}\n${demote(tag.fragment)}${corner}`);
  }
  const naming = namingSection(selection.naming);
  // Guidance first, so it frames the notes instead of arriving last and overwriting them.
  const guidance = `# User guidance\n${userGuidance?.trim() || "None."}`;
  return {
    system: generatorSystemPrompt(),
    user: `${guidance}\n\n# Research notes\n\n${sections.join("\n\n")}${naming ? `\n\n${naming}` : ""}`.trim(),
    tags: chosen.map((t) => t.id),
    rolled,
    pockets,
    ...(selection.naming?.kind === "given" ? { name: selection.naming.name } : {}),
  };
}

// --------------------------------------------------------------- parsing

/** The model's reply, read: `name:` and `pronouns:` lines, then the body from its first heading. */
export function parseReply(content: string): { name: string; pronouns: string; body: string } {
  const text = content
    .replace(/\r\n?/g, "\n")
    .replace(/^```(?:\w+)?\n([\s\S]*?)\n```\s*$/m, "$1")
    // Working notes are scratch work (dev mode's Raw output keeps them): drop them,
    // up to the name line that has the pronouns line right under it.
    .replace(/^#{1,4}\s*Working notes\s*$[\s\S]*?(?=^\s*\**name\**\s*:[^\n]*\n\s*\**pronouns\**\s*:)/im, "")
    .trim();
  const first = text.search(/^##\s/m);
  // Only the lines before the body count, and the last of each wins.
  const head = first === -1 ? text : text.slice(0, first);
  const line = (key: string) =>
    [...head.matchAll(new RegExp(`^\\s*\\**${key}\\**\\s*:\\s*\\**\\s*(.+?)\\s*$`, "gim"))].at(-1)?.[1]?.replace(/\*+$/, "").trim() ?? "";
  return { name: line("name"), pronouns: line("pronouns"), body: first === -1 ? "" : text.slice(first).trim() };
}

// ------------------------------------------------------------ generating

/** One attempt, as dev mode's Raw output shows it. */
export interface Attempt {
  raw: string | null;
  error: string | null;
  problems: SeedProblem[];
}

/** The last generation, for dev mode: the prompt it sent and how each attempt went. */
export interface Generation {
  id: string;
  at: string;
  profile: string;
  model: string;
  system: string;
  user: string;
  attempts: Attempt[];
  ok: boolean;
}

/** A seed couldn't be made, even on the second try. Its message is for people. */
export class SeedError extends Error {
  constructor(
    message: string,
    readonly generation: Generation,
    /** What the seed needed (seedRules), when it came back but failed the checks. */
    readonly expected: string[] = [],
  ) {
    super(message);
    this.name = "SeedError";
  }
}

/** What every seed needs (the checks in validateSeed), in words, to set beside what came back. */
function seedRules(words: { min: number; max: number } = SEED_WORDS): string[] {
  return [
    "A name line and a pronouns line.",
    `These headings, in this order: ${SEED_HEADINGS.map((h) => `## ${h}`).join(", ")}.`,
    `${words.min} to ${words.max} words.`,
    `Every "Voice" bullet says how often: ${DOSAGE_WORDS.join(", ")}.`,
    '"Left open" has 2 or 3 bullets.',
    "None of the tags' avoid terms.",
  ];
}

/** "Didn't come out right, twice", and what was wrong with each try, one line each. */
function seedFailure(generation: Generation): string {
  const tries = generation.attempts.map((a, i) => `${i === 0 ? "First" : "Second"} try: ${a.problems.map((p) => p.message).join(" ")}`);
  return ["Their seed didn't come out right, twice.", ...tries, "Try again for someone new."].join("\n");
}

/** What a finished seed comes back as: the file, its parts, and which generation made it. */
export interface GeneratedSeed {
  text: string;
  header: Seed["header"];
  body: string;
  generation: string;
}

/**
 * One seed: one call, checked, and once more if it fails. `words` is only
 * for tests (forcing a failure), and defaults to SEED_WORDS (350 to 750).
 */
export async function generateSeed(
  api: ApiOptions,
  profile: Profile,
  prompt: SeedPrompt,
  context: { source: SeedSource; avoidTerms: string[]; words?: { min: number; max: number }; record?: (g: Generation) => void; now?: Date },
): Promise<GeneratedSeed> {
  const generation: Generation = {
    id: crypto.randomUUID(),
    at: (context.now ?? new Date()).toISOString(),
    profile: profile.name,
    model: profile.model,
    system: prompt.system,
    user: prompt.user,
    attempts: [],
    ok: false,
  };
  const request = profileRequest(profile);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string;
      try {
        const response = await createChatCompletion(api, {
          ...request,
          // Working notes and the seed together run long.
          maxTokens: Math.max(request.maxTokens, 4000),
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        });
        raw = response.content;
      } catch (error) {
        const message = error instanceof ApiError ? error.message : (error as Error).message;
        generation.attempts.push({ raw: null, error: message, problems: [] });
        // The model couldn't be reached: trying again right away rarely helps.
        throw new SeedError(`Couldn't reach the model to write them: ${message}`, generation);
      }
      const reply = parseReply(raw);
      // A name you gave is theirs, whatever the model wrote on the name line.
      if (prompt.name) reply.name = prompt.name;
      const problems = validateSeed({ header: reply, body: reply.body }, { avoidTerms: context.avoidTerms, words: context.words });
      generation.attempts.push({ raw, error: null, problems });
      if (problems.length === 0) {
        const seed: Seed = {
          header: {
            id: newSeedId(),
            name: reply.name,
            pronouns: reply.pronouns,
            source: context.source,
            tags: prompt.tags,
            rolled: prompt.rolled,
            pockets: prompt.pockets,
            model: profile.model,
            created: today(context.now),
            seed_version: SEED_VERSION,
          },
          body: reply.body,
        };
        generation.ok = true;
        return { text: writeSeed(seed), header: seed.header, body: seed.body, generation: generation.id };
      }
    }
    // What each try got wrong, in words; the full replies are in dev mode's Raw output.
    throw new SeedError(seedFailure(generation), generation, seedRules(context.words));
  } finally {
    context.record?.(generation);
  }
}

// ---------------------------------------------------------------- an idea

/**
 * Generate from idea: the tags you attached, plus the ones your words
 * obviously suggest, by Jev. Each category you left open is one question,
 * "none" first; a tag counts only when Jev is sure of it (`confidence`).
 * If you attached none and none stand out (or Jev can't be asked), one to
 * three tags are rolled instead. The rest stays your words alone.
 *
 * `chosen` is what you attached (tags, and corners for them); a category
 * you filled is never asked about, and your picks are never "rolled".
 */
export async function ideaTags(
  allTags: Tag[],
  idea: string,
  decider: Decider | null,
  confidence: number,
  random: () => number = Math.random,
  chosen: SeedSelection = { tags: {} },
): Promise<{ selection: SeedSelection; picked: string[] }> {
  const tags: SeedSelection["tags"] = {};
  const attached: string[] = [];
  for (const category of CATEGORIES) {
    const value = chosen.tags[category.id];
    const wanted = (Array.isArray(value) ? value : value ? [value] : []).slice(0, allowsMultiple(category.id) ? undefined : 1);
    const ids = [...new Set(wanted)].filter((id) => allTags.some((t) => t.id === id && t.category === category.id));
    if (!ids.length) continue;
    tags[category.id] = allowsMultiple(category.id) ? ids : ids[0]!;
    attached.push(...ids);
  }
  const pockets = chosen.pockets && Object.keys(chosen.pockets).length ? { pockets: chosen.pockets } : {};
  const categories = CATEGORIES.filter((c) => !(c.id in tags) && allTags.some((t) => t.category === c.id));
  const picked: string[] = [];
  if (decider?.enabled() && categories.length) {
    const words = wording("generator");
    const questions: Question[] = categories.map((c) => ({
      id: c.id,
      kind: "choice",
      question: fill(words["idea-question"] ?? "", { category: c.label.toLowerCase() }),
      options: ["none", ...allTags.filter((t) => t.category === c.id).map((t) => t.label)],
    }));
    try {
      const answers = await decider.ask(fill(words["idea-context"] ?? "", { idea }), questions, { purpose: "Generate from idea" });
      for (const c of categories) {
        const answer = answers.get(c.id);
        if (!answer || answer.selected === "none" || answer.confidence < confidence) continue;
        const tag = allTags.find((t) => t.category === c.id && t.label === answer.selected);
        if (tag) picked.push(tag.id);
      }
    } catch (error) {
      console.warn(`[seeds] Jev couldn't read the idea: ${(error as Error).message}`);
    }
  }
  if (attached.length || picked.length) {
    for (const id of picked) tags[id.split(".")[0] as CategoryId] = id;
    return { selection: { tags, ...pockets }, picked };
  }
  // Nothing obvious: one to three tags, by chance, from different categories.
  const count = 1 + Math.min(2, Math.floor(random() * 3));
  const pool = [...categories];
  const rolled: string[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const [category] = pool.splice(Math.floor(random() * pool.length), 1);
    const options = allTags.filter((t) => t.category === category!.id);
    const tag = options[Math.floor(random() * options.length)]!;
    tags[category!.id] = tag.id;
    rolled.push(tag.id);
  }
  return { selection: { tags, rolledTags: rolled, ...pockets }, picked };
}
