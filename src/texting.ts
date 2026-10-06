/**
 * Texting in OOC: your kinwriter's replies as a burst of short bubbles, the
 * way people text, borrowed from Kitsikai (and the owner's Lumiverse
 * extension and Tiny RP before it).
 *
 * The model is asked to put a `<cht>` marker between the bubbles of a
 * reply:
 *
 *   omg wait<cht>you actually said that to him??<cht>legend
 *
 * becomes three messages: "omg wait", "you actually said that to him??",
 * "legend". The same marker goes between your kinwriter's bubbles in the
 * conversation the model reads (`toChatHistory` in src/prompt.ts), so it
 * keeps mirroring the format. The app shows the bubbles one at a time, with
 * "typing…" between them (public/js/texting.js).
 *
 * Models aren't perfectly tidy, so the splitter forgives: `<CHT>`,
 * `< cht >`, `</cht>` and `<cht/>` all count.
 */

/** The marker, as written in prompts. */
import { fill, wording } from "./wording.ts";

export const BUBBLE_MARKER = "<cht>";

const MARKER = /<\s*\/?\s*cht\s*\/?\s*>/gi;

/** Split a reply into bubbles (no marker: one bubble). Empty pieces are dropped. */
export function splitTexts(text: string): string[] {
  return text
    .split(MARKER)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
}

/** The instruction added to OOC prompts when bubbles are on (`texting-style` in defaults/turns.md). */
export const textingStyle = (): string => fill(wording("turns")["texting-style"] ?? "", { marker: BUBBLE_MARKER });
