/**
 * Tests for small text helpers and lookups: frontmatter round trips,
 * pulling JSON out of a reply, dice notation, shell quoting, short ids,
 * the mirror's words, rewrites, and Jev's per-call report.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { roll } from "../src/dice.ts";
import { findByShortId, NotFoundError } from "../src/errors.ts";
import { markdownSections, splitFrontmatter, writeFrontmatter } from "../src/frontmatter.ts";
import { Decider } from "../src/jev.ts";
import { extractJson } from "../src/json.ts";
import { readPatterns } from "../src/mirror.ts";
import { shellQuote } from "../src/notify.ts";
import { Store } from "../src/store.ts";
import { parseSections } from "../src/wording.ts";
import { startFakeNanoGpt, type FakeNanoGpt } from "./helpers.ts";

describe("frontmatter", () => {
  test("a quoted value reads back as it was written", () => {
    for (const label of ['"Doc" Holliday', "'tis the season", "back\\slash", "[not a list]", "42", "true"]) {
      const { header } = splitFrontmatter(writeFrontmatter({ label }, "Body."));
      expect(header.label).toBe(label);
    }
  });

  test("a hand-written quoted value that isn't JSON keeps its text", () => {
    expect(splitFrontmatter('---\npath: "C:\\path"\n---\n').header.path).toBe("C:\\path");
  });

  test("## sections, the same for every file type", () => {
    const text = "A note.\n## one\nFirst.\n\n## two\nSecond.\n## one\nAgain.";
    expect(markdownSections(text)).toEqual([
      { heading: "one", text: "First." },
      { heading: "two", text: "Second." },
      { heading: "one", text: "Again." },
    ]);
    expect(parseSections(text)).toEqual({ one: "Again.", two: "Second." });
  });
});

describe("JSON in a reply", () => {
  test("a bracket before the JSON doesn't hide it", () => {
    expect(extractJson('Here [as asked]: {"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  test("repairs leave what's inside strings alone", () => {
    expect(extractJson('{"line": "It’s late, isn’t it?", "list": [1, 2,],}')).toEqual({ line: "It’s late, isn’t it?", list: [1, 2] });
    expect(extractJson("{“name”: “Ilse”, \"url\": \"http://x.org\" // a comment\n}")).toEqual({ name: "Ilse", url: "http://x.org" });
  });

  test("still throws when there's nothing to read", () => {
    expect(() => extractJson("no json [here")).toThrow();
  });
});

describe("dice", () => {
  test("stray signs are refused", () => {
    for (const notation of ["2d6--3", "2d6+-3", "2d6+", "+-2d6", "2d6++1"]) expect(() => roll(notation)).toThrow(/one \+ or -/);
    expect(roll("2d6-3", () => 0).total).toBe(-1);
    expect(roll("-1+d4", () => 0).total).toBe(0);
  });
});

test("a URL with a quote in it stays one word for the shell", () => {
  expect(shellQuote("http://x/#/channel/it's")).toBe("'http://x/#/channel/it'\\''s'");
});

describe("short ids", () => {
  const items = [{ id: "3F2a9c1e-aaaa" }, { id: "3f2b0000-bbbb" }, { id: "77aa" }];
  test("case-insensitive prefix, brackets and # off, one match only", () => {
    expect(findByShortId(items, "[3f2a]", "note")).toBe(items[0]!);
    expect(findByShortId(items, "#77", "note")).toBe(items[2]!);
    expect(() => findByShortId(items, "3f2", "note")).toThrow(NotFoundError);
    expect(() => findByShortId([items[0]!], "  ", "note")).toThrow(NotFoundError);
    expect(() => findByShortId([items[0]!], "[]", "note")).toThrow(NotFoundError);
  });
});

describe("with a store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });
  afterEach(() => store.close());
  const ooc = () => store.listChannels().find((c) => c.kind === "ooc")!;

  test("rewrites: found by short id with no wildcards; a quote of only marks is refused", () => {
    const [message] = store.addTurn([{ channelId: ooc().id, author: "kinwriter", content: "The *bell* rang." }]);
    const rewrite = store.rewrites.suggest(message!.id, "bell", "lamp");
    expect(store.rewrites.find(rewrite.id.slice(0, 8).toUpperCase()).id).toBe(rewrite.id);
    expect(() => store.rewrites.find("%")).toThrow(NotFoundError);
    expect(() => store.rewrites.find("_")).toThrow(NotFoundError);
    expect(() => store.rewrites.find("")).toThrow(NotFoundError);
    expect(() => store.rewrites.suggest(message!.id, "**", "lamp")).toThrow(/Highlight/);
  });

  test("the mirror counts words in any language", () => {
    for (const text of ["Die Glocke läutete über dem Wasser.", "La cloche sonnait sur l'eau grise.", "Колокол звонил над водой."]) {
      store.addTurn([{ channelId: ooc().id, author: "kinwriter", content: text }]);
    }
    const report = readPatterns(store, ooc(), "channel");
    expect(report.sentence_length_in_words?.average).toBeGreaterThan(3);
  });
});

describe("Jev's report", () => {
  let fake: FakeNanoGpt;
  beforeEach(() => {
    fake = startFakeNanoGpt();
  });
  afterEach(() => fake.stop());

  test("each call gets its own, even when calls overlap", async () => {
    const decider = new Decider({ apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 }, () => ({ decisionModel: "jev", fallback: null }));
    fake.jevReplies.push({ content: JSON.stringify({ answers: { q: { choice: "yes", probabilities: { yes: 0.9, no: 0.1 } } } }) });
    fake.jevReplies.push({ status: 500, error: "down" });
    const question = [{ id: "q", kind: "yesno" as const, question: "?" }];
    const first = decider.askWithReport("state", question);
    const second = decider.askWithReport("state", question).catch((error: Error) => error);
    expect((await first).report).toMatchObject({ answeredBy: "jev", jevError: null });
    expect(await second).toBeInstanceOf(Error);
  });
});
