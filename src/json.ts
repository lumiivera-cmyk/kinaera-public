/**
 * Getting JSON out of a model's reply.
 *
 * When a normal chat model is asked for "JSON only", it usually obliges, but
 * not always tidily: the JSON can come wrapped in ```json fences, after a
 * sentence like "Here are the shifts:", with a trailing comma, or with curly
 * quotes. `extractJson` finds the JSON and repairs what it safely can, the
 * same way src/toolcalls.ts forgives broken tool arguments.
 *
 * (Jev, the decision model, never needs this: its answers are typed by
 * design. This is for the fallback profile, and anything else asked to reply in JSON.)
 */

import { stripReasoning } from "./nanogpt.ts";

/** Why a reply couldn't be read as JSON. */
export class JsonReplyError extends Error {
  constructor(readonly reply: string) {
    super("The model's reply wasn't the JSON it was asked for.");
    this.name = "JsonReplyError";
  }
}

/**
 * Find and parse the JSON value (object or list) in a reply.
 *
 * @throws JsonReplyError if there isn't one that can be read.
 */
export function extractJson(reply: string): unknown {
  let text = stripReasoning(reply).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) text = fenced[1]!.trim();

  // From a { or [ to the last matching } or ]: the first such start that
  // reads, so "Here [as asked]: {...}" still finds the object.
  let tries = 0;
  for (let start = text.search(/[[{]/); start >= 0 && tries < 50; start = nextStart(text, start), tries++) {
    const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
    if (end <= start) continue;
    const candidate = text.slice(start, end + 1);
    for (const attempt of [candidate, repair(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        // try the next one
      }
    }
  }
  throw new JsonReplyError(reply);
}

/** Where the next { or [ after `from` is (-1: none). */
function nextStart(text: string, from: number): number {
  const next = text.slice(from + 1).search(/[[{]/);
  return next < 0 ? -1 : from + 1 + next;
}

/**
 * Fix the usual small mistakes: trailing commas, curly quotes around keys
 * and values, // comments. What's inside a string is left as it was (an
 * apostrophe stays ’).
 */
function repair(text: string): string {
  let out = "";
  // Inside a string: what ends it (" or, for one opened with a curly quote, ”).
  let closer: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (closer) {
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i++;
      } else if (c === closer) {
        out += '"';
        closer = null;
      } else {
        // A straight quote inside a curly-quoted string is part of the text.
        out += c === '"' ? '\\"' : c;
      }
    } else if (c === '"' || c === "“" || c === "”") {
      closer = c === '"' ? '"' : "”";
      out += '"';
    } else if (c === "/" && text[i + 1] === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (c === "," && /[}\]]/.test(text[nextNonSpace(text, i + 1)] ?? "")) {
      // A trailing comma: dropped.
    } else {
      out += c;
    }
  }
  return out;
}

function nextNonSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}
