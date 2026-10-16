/**
 * The seed generator (design/kinwriter-generation/spec.md, "Generator
 * prompt"): one prompt-assembly function and one model call.
 *
 *   1. `buildSeedPrompt` fills every "Surprise me" category at random, then
 *      rolls one pocket for each tag that has them (unless you chose one),
 *      and records what chance picked. It assembles the user message: your
 *      guidance first (so it frames the rest), then each tag's fragment
 *      without its Pockets section, and the chosen or rolled pocket's
 *      bullets under "This person's corner". The system prompt is
 *      `kinwriter-generator/system-prompt.md`, read as it is.
 *   2. `generateSeed` sends one call, with the profile marked "Use for
 *      creating kinwriters" (or the default profile; never a roulette), with
 *      its own samplers and reasoning setting.
 *   3. The reply is parsed: the model's Working notes are dropped, then the
 *      `name:` and `pronouns:` lines, then the headings. The header is built here: the model never writes `id`,
 *      `source`, `tags`, `rolled`, `pockets`, `model`, `created` or
 *      `seed_version`.
 *   4. It's checked (src/seeds.ts). On a failure, it tries once more with
 *      the same inputs; a second failure is a readable error.
 *
 * "Generate from idea" uses the same pipeline with your words as the user
 * guidance. Jev first reads your idea for tags it obviously suggests; if
 * none stand out, one to three tags are rolled, and everything else comes
 * from your words alone (`ideaTags`).
 *
 * Dev mode keeps the last generation (`lastGeneration`): the assembled
 * prompt, and each attempt's raw reply with what it failed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError, createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import { profileRequest } from "./kinwriter.ts";
import type { Decider, Question } from "./jev.ts";
import { newSeedId, SEED_VERSION, today, validateSeed, writeSeed, type Seed, type SeedProblem, type SeedSource } from "./seeds.ts";
import { CATEGORIES, type CategoryId, type Tag } from "./tags.ts";
import type { Profile } from "./types.ts";

/** The generator's instructions: a file, so they can be tuned without touching code. */
export const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "..", "kinwriter-generator", "system-prompt.md");

export function generatorSystemPrompt(): string {
  return readFileSync(SYSTEM_PROMPT_FILE, "utf8").trim();
}

/** What you picked: a tag per category (null: "Surprise me"), and corners you chose. */
export interface SeedSelection {
  tags: Partial<Record<CategoryId, string | null>>;
  /**
   * Tags kept from an earlier roll that still count as rolled (Reroll keeps
   * the same tags, chance's included, and only rolls the person again).
   */
  rolledTags?: string[];
  /** Chosen pockets: `{ "social.twitter-2010s": "absurdist" }`. */
  pockets?: Record<string, string>;
}

export interface SeedPrompt {
  system: string;
  user: string;
  /** The final tags, in category order. */
  tags: string[];
  /** Which tags and pockets chance picked (`category.slug`, `category.slug#pocket`). */
  rolled: string[];
  /** Every pocket, chosen or rolled. */
  pockets: string[];
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
    const wanted = selection.tags[category.id];
    const found = wanted ? options_.find((t) => t.id === wanted) : undefined;
    if (found) {
      chosen.push(found);
      if (kept.has(found.id)) rolled.push(found.id);
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
  const guidance = `# User guidance\n${userGuidance?.trim() || "None."}`;
  return {
    system: generatorSystemPrompt(),
    user: `${guidance}\n\n# Research notes\n\n${sections.join("\n\n")}`.trim(),
    tags: chosen.map((t) => t.id),
    rolled,
    pockets,
  };
}

// --------------------------------------------------------------- parsing

/**
 * The model's reply, read: its Working notes dropped (they're scratch work,
 * kept only in dev mode's Raw output), then the `name:` and `pronouns:`
 * lines, then the body from its first `##` heading.
 */
export function parseReply(content: string): { name: string; pronouns: string; body: string } {
  const text = content
    .replace(/\r\n?/g, "\n")
    .replace(/^```(?:\w+)?\n([\s\S]*?)\n```\s*$/m, "$1")
    // Up to the name line that has the pronouns line right under it.
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
  ) {
    super(message);
    this.name = "SeedError";
  }
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
    // Short, for people: what failed is in dev mode's Raw output.
    throw new SeedError("Their seed didn't come out right, twice. Try again for someone new.", generation);
  } finally {
    context.record?.(generation);
  }
}

// ---------------------------------------------------------------- an idea

/**
 * Generate from idea: the tags your words obviously suggest, by Jev. Each
 * category is one question, "none" first; a tag counts only when Jev is
 * sure of it (`confidence`). If none stand out (or Jev can't be asked),
 * one to three tags are rolled instead. The rest stays your words alone.
 */
export async function ideaTags(
  allTags: Tag[],
  idea: string,
  decider: Decider | null,
  confidence: number,
  random: () => number = Math.random,
): Promise<{ selection: SeedSelection; picked: string[] }> {
  const categories = CATEGORIES.filter((c) => allTags.some((t) => t.category === c.id));
  const picked: string[] = [];
  if (decider?.enabled()) {
    const questions: Question[] = categories.map((c) => ({
      id: c.id,
      kind: "choice",
      question: `Does this idea for a writing partner obviously call for one of these as their ${c.label.toLowerCase()}? Answer "none" unless the idea clearly points to one.`,
      options: ["none", ...allTags.filter((t) => t.category === c.id).map((t) => t.label)],
    }));
    try {
      const answers = await decider.ask(`The user's idea for a new kinwriter (a writing partner):\n${idea}`, questions, { purpose: "Generate from idea" });
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
  const tags: SeedSelection["tags"] = {};
  if (picked.length) {
    for (const id of picked) tags[id.split(".")[0] as CategoryId] = id;
    return { selection: { tags }, picked };
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
  return { selection: { tags, rolledTags: rolled }, picked };
}
