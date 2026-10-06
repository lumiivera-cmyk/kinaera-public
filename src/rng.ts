/**
 * RNG kinwriter creation: "Surprise me" in Settings writes a new kinwriter for
 * you, from a few random ingredients, so it's someone you wouldn't have
 * thought of.
 *
 * Asking a model for "a random character" gets the same few every time, so
 * the randomness comes from here: a temperament, a way of talking, two
 * interests, a quirk, and what they love in a story, each picked at random
 * from lists below (`rollSeeds`). The model (the profile that writes OOC)
 * turns them into a name, a "who your kinwriter is" prompt (written the way
 * the default one is), and their tastes. Nothing is saved until you press Save;
 * roll again as often as you like.
 */

import { extractJson } from "./json.ts";
import { createChatCompletion, type ApiOptions } from "./nanogpt.ts";
import type { Profile } from "./types.ts";
import { profileRequest } from "./kinwriter.ts";
import { fill, wording } from "./wording.ts";

const TEMPERAMENTS = [
  "warm and teasing", "dry and deadpan", "earnest and a little shy", "chaotic and enthusiastic", "calm and thoughtful",
  "sardonic but soft underneath", "gentle and dreamy", "blunt and loyal", "playful and dramatic", "quietly intense",
  "sunny and easily excited", "wry and observant", "cozy and nurturing", "restless and curious",
];
const VOICES = [
  "texts in lowercase with lots of ellipses", "uses exclamation points freely", "writes in short, punchy lines",
  "rambles happily when excited", "loves a well-placed emoji", "is precise and a bit formal", "swears affectionately",
  "asks a lot of questions", "makes terrible puns", "quotes old films", "types fast and fixes typos with *",
];
const INTERESTS = [
  "old maps", "horror movies", "baking bread", "astronomy", "folk music", "urban legends", "tabletop RPGs", "gardening",
  "true crime podcasts", "mythology", "thrifting", "birdwatching", "anime", "Victorian novels", "street photography",
  "cryptids", "fencing", "tarot", "architecture", "video game lore", "tea", "sailing", "fashion history", "linguistics",
];
const QUIRKS = [
  "names every houseplant", "can't resist a cliffhanger", "keeps a notebook of overheard lines", "is terrible with directions",
  "has strong opinions about fonts", "collects weird facts", "always roots for the villain", "cries at happy endings",
  "stays up far too late writing", "hums while thinking", "is secretly very competitive",
];
const STORY_LOVES = [
  "slow-burn romance", "found family", "political intrigue", "cozy mysteries", "cosmic horror", "heists", "court drama",
  "enemies to lovers", "survival stories", "fairy tales retold", "morally grey heroes", "small-town secrets", "space opera",
  "gothic atmosphere", "quiet slice of life", "high-stakes adventure",
];

export interface KinwriterSeeds {
  temperament: string;
  voice: string;
  interests: string[];
  quirk: string;
  loves: string[];
}

/** Pick a few ingredients at random. */
export function rollSeeds(random: () => number = Math.random): KinwriterSeeds {
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const pickTwo = <T>(list: T[]): T[] => {
    const first = pick(list);
    let second = pick(list);
    for (let i = 0; second === first && i < 10; i++) second = pick(list);
    return second === first ? [first] : [first, second];
  };
  return { temperament: pick(TEMPERAMENTS), voice: pick(VOICES), interests: pickTwo(INTERESTS), quirk: pick(QUIRKS), loves: pickTwo(STORY_LOVES) };
}

/** The seeds in words, as shown in Settings. */
export function describeSeeds(seeds: KinwriterSeeds): string {
  return `${seeds.temperament}; ${seeds.voice}; into ${seeds.interests.join(" and ")}; ${seeds.quirk}; loves ${seeds.loves.join(" and ")}`;
}

/** Ask the model to turn the seeds into a kinwriter: a name, and who they are. */
export async function randomKinwriter(api: ApiOptions, profile: Profile, seeds: KinwriterSeeds): Promise<{ name: string; prompt: string; tastes: string }> {
  const request = profileRequest(profile);
  // The request's wording is in defaults/surprise.md.
  const words = wording("surprise");
  const response = await createChatCompletion(api, {
    ...request,
    temperature: Math.max(request.temperature, 0.9),
    maxTokens: Math.max(request.maxTokens, 700),
    messages: [
      {
        role: "system",
        content: fill(words.system ?? "", {
          temperament: seeds.temperament,
          voice: seeds.voice,
          interests: seeds.interests.join(", "),
          quirk: seeds.quirk,
          loves: seeds.loves.join(", "),
        }),
      },
      { role: "user", content: words.user ?? "Surprise me." },
    ],
  });
  const json = extractJson(response.content) as { name?: unknown; prompt?: unknown; tastes?: unknown };
  const name = typeof json?.name === "string" ? json.name.trim().slice(0, 40) : "";
  const prompt = typeof json?.prompt === "string" ? json.prompt.trim().slice(0, 4000) : "";
  if (!name || !prompt) throw new Error("The model's answer didn't have a name and a description. Try again.");
  // Tastes are welcome but not required: they can find their own later.
  const tastes = typeof json?.tastes === "string" ? json.tastes.trim().slice(0, 4000) : "";
  return { name, prompt, tastes };
}
