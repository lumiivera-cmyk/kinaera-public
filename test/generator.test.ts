/**
 * Kinwriter generation, steps 2 to 4 (design/kinwriter-generation/spec.md, "Build order"):
 * tag files and the picker built from them, the generator (prompt
 * assembly, one call, checks, one retry), the generator profile, Generate
 * from idea, and the dev tools.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type App } from "../src/server.ts";
import { buildSeedPrompt, generateSeed, generatorSystemPrompt, ideaTags, parseReply, SeedError } from "../src/generator.ts";
import { loadTags, parseTagFile, pickerView, readTagFiles, TAGS_DIR } from "../src/tags.ts";
import { parseSeed, SEED_HEADINGS } from "../src/seeds.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

const MARGO = readFileSync(join(import.meta.dir, "..", "kinwriter-generator", "test-seed.md"), "utf8");
/**
 * A good reply: Margo's name, pronouns and body, the way the model writes
 * them.
 */
const GOOD = `name: Margo\npronouns: she/her\n\n${parseSeed(MARGO).body}`;

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let app: App;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  app = createApp(testConfig(dir.path, fake.baseUrl, { developerPanel: true }));
});

afterEach(() => {
  app.summarizer.stop();
  app.store.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as any };
}

/** A copy of the tag files to change, as `kinwriter-tags` beside it. */
function copyTags(): string {
  const copy = join(dir.path, "tags-copy", "kinwriter-tags");
  cpSync(TAGS_DIR, copy, { recursive: true });
  return copy;
}

// ------------------------------------------------------------ tag files

describe("tag files", () => {
  test("every file converted from the fragment docs passes Check files", () => {
    const { tags, problems } = readTagFiles();
    expect(problems).toEqual([]);
    const count = (c: string) => tags.filter((t) => t.category === c).length;
    expect([count("personality"), count("temperament"), count("prose"), count("inspiration"), count("social")]).toEqual([10, 4, 6, 6, 8]);
    for (const tag of tags.filter((t) => t.category === "social" || t.category === "inspiration")) {
      expect(tag.pockets.length).toBeGreaterThanOrEqual(3);
      expect(tag.pockets.length).toBeLessThanOrEqual(5);
      expect(tag.avoidTerms.length).toBeGreaterThan(0);
    }
    expect(tags.find((t) => t.id === "social.twitter-2010s")).toMatchObject({ label: "Twitter (2010s)", order: 1, avoidTerms: expect.arrayContaining(["quote-tweet"]) });
    // The fragment the generator reads has no pockets in it.
    expect(tags.find((t) => t.id === "social.reddit")!.fragment).not.toContain("## Pockets");
  });

  test("Check files finds what's wrong: a missing field, a missing section, a pocket without a blurb", () => {
    const text = readFileSync(join(TAGS_DIR, "social", "reddit.md"), "utf8");
    const broken = text.replace(/^blurb: .*$/m, "").replace("## Tics", "## Tricks").replace(/(### storyteller\nlabel: .*\n)blurb: .*\n/, "$1");
    const { problems } = parseTagFile(broken, "social/reddit.md", "social");
    expect(problems.join(" ")).toContain('"blurb"');
    expect(problems.join(" ")).toContain('"## Tics"');
    expect(problems.join(" ")).toContain('Pocket "storyteller" has no blurb');
  });

  test("adding, changing or deleting a file changes the picker, with no code change", () => {
    const copy = copyTags();
    const before = pickerView(loadTags({ dir: copy }));
    writeFileSync(
      join(copy, "social", "myspace.md"),
      `---\nid: social.myspace\ncategory: social\nlabel: MySpace\nblurb: Top eight energy.\norder: 9\navoid_terms: [MySpace]\n---\n\n## Era\nThe 2000s.\n\n## Texture\nx\n\n## Ways it can go\nx\n\n## On the page\nx\n\n## In OOC\nx\n\n## Tics\n- **Glitter, rarely.**\n\n## Avoid\nx\n\n## Tension hooks\nx\n`,
    );
    writeFileSync(join(copy, "prose", "lush.md"), readFileSync(join(copy, "prose", "lush.md"), "utf8").replace(/^label: Lush$/m, "label: Lavish"));
    rmSync(join(copy, "temperament", "formal.md"));
    const after = pickerView(loadTags({ dir: copy }));
    const social = after.find((c) => c.id === "social")!.options;
    expect(social.at(-1)).toMatchObject({ label: "MySpace", era: "The 2000s.", tics: ["Glitter, rarely."] });
    expect(after.find((c) => c.id === "prose")!.options.map((o) => o.label)).toContain("Lavish");
    expect(after.find((c) => c.id === "temperament")!.options).toHaveLength(before.find((c) => c.id === "temperament")!.options.length - 1);
  });

  test("a broken file is skipped normally, and a hard error in dev mode", () => {
    const copy = copyTags();
    writeFileSync(join(copy, "prose", "broken.md"), "---\nid: prose.broken\ncategory: prose\n---\n\nnothing");
    expect(loadTags({ dir: copy }).some((t) => t.id === "prose.broken")).toBe(false);
    expect(() => loadTags({ dir: copy, strict: true })).toThrow("prose/broken.md");
  });

  test("the picker: five categories in order, Surprise me, the social subtitle, details page fields", async () => {
    const { data } = await call("GET", "/api/seeds/tags");
    expect(data.categories.map((c: any) => c.label)).toEqual(["Personality", "Temperament", "Prose style", "Biggest influence", "Primary social media"]);
    const social = data.categories[4];
    expect(social.subtitle).toBe("i promise this option is interesting");
    expect(social.options[0]).toMatchObject({ label: "Twitter (2010s)", era: expect.stringContaining("2010s Twitter") });
    expect(social.options[0].tics[0]).toContain("Lowercase in casual OOC");
    // Personality takes several; the rest take one.
    expect(data.categories.map((c: any) => c.multiple)).toEqual([true, false, false, false, false]);
    // The fragments never go to the app.
    expect(JSON.stringify(data)).not.toContain("Tension hooks");
  });
});

// ------------------------------------------------------------ the prompt

describe("buildSeedPrompt", () => {
  const tags = loadTags();
  /** A fixed sequence of "random" numbers. */
  const seq = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length]!;
  };

  test("Surprise me fills every category at random, and rolls a pocket for each tag that has them", () => {
    const prompt = buildSeedPrompt(tags, { tags: {} }, undefined, { random: seq(0) });
    expect(prompt.tags).toHaveLength(5);
    expect(prompt.rolled).toEqual(expect.arrayContaining(prompt.tags));
    expect(prompt.pockets).toHaveLength(2);
    for (const pocket of prompt.pockets) expect(prompt.rolled).toContain(pocket);
    expect(prompt.system).toBe(generatorSystemPrompt());
  });

  test("the user message, as the spec lays it out", () => {
    const prompt = buildSeedPrompt(
      tags,
      { tags: { prose: "prose.sparse", social: "social.twitter-2010s", personality: "personality.reserved", temperament: "temperament.critical", inspiration: "inspiration.games" }, pockets: { "social.twitter-2010s": "writers" } },
      undefined,
      { random: seq(0) },
    );
    expect(prompt.user.startsWith("# User guidance\nNone.\n\n# Research notes\n\n## Personality: Reserved\n")).toBe(true);
    expect(prompt.user).toContain("### Ways it can go\n");
    expect(prompt.user).toContain("## Prose style: Sparse\n");
    expect(prompt.user).toContain("## Primary social media: Twitter (2010s)\n### Era\n");
    // The chosen pocket's bullets, under "This person's corner", and no other pocket.
    expect(prompt.user).toContain("### This person's corner\n- Craft threads, process talk");
    expect(prompt.user).not.toContain("Weird Twitter");
    expect(prompt.user).not.toContain("label:");
    // Picked, not rolled; the games pocket was rolled.
    expect(prompt.rolled).toEqual(["inspiration.games#" + prompt.pockets.find((p) => p.startsWith("inspiration.games"))!.split("#")[1]]);
    expect(prompt.pockets).toContain("social.twitter-2010s#writers");
  });

  test("user guidance goes first, under its own heading, so it frames the notes", () => {
    const prompt = buildSeedPrompt(tags, { tags: { prose: "prose.lush" } }, "A lighthouse keeper.", { fill: false });
    expect(prompt.tags).toEqual(["prose.lush"]);
    expect(prompt.user.startsWith("# User guidance\nA lighthouse keeper.\n\n# Research notes\n")).toBe(true);
  });

  test("Reroll keeps the tags (chance's still marked rolled) and chosen pockets; rolled pockets roll fresh", () => {
    const first = buildSeedPrompt(tags, { tags: { social: "social.reddit" }, pockets: {} }, undefined, { random: seq(0.1) });
    const keepTags = Object.fromEntries(first.tags.map((t) => [t.split(".")[0], t]));
    const again = buildSeedPrompt(tags, { tags: keepTags, rolledTags: first.rolled.filter((r) => !r.includes("#")) }, undefined, { random: seq(0.9) });
    expect(again.tags).toEqual(first.tags);
    expect(again.rolled.filter((r) => !r.includes("#"))).toEqual(first.rolled.filter((r) => !r.includes("#")));
    expect(again.pockets).not.toEqual(first.pockets);
  });

  test("several personalities: each gets a section, all count as picked, nothing else is rolled for them", () => {
    const prompt = buildSeedPrompt(tags, { tags: { personality: ["personality.warm", "personality.chaotic", "personality.warm"] } }, undefined, { random: seq(0) });
    expect(prompt.tags.filter((t) => t.startsWith("personality."))).toEqual(["personality.warm", "personality.chaotic"]);
    expect(prompt.rolled.some((r) => r.startsWith("personality."))).toBe(false);
    expect(prompt.user).toContain("## Personality: Warm\n");
    expect(prompt.user).toContain("## Personality: Chaotic\n");
    expect(prompt.system).toContain("blend them into one person");
    // An empty list is "Surprise me": one is rolled.
    const empty = buildSeedPrompt(tags, { tags: { personality: [] } }, undefined, { random: seq(0) });
    expect(empty.rolled.filter((r) => r.startsWith("personality."))).toHaveLength(1);
    // A category that takes one keeps only the first.
    const one = buildSeedPrompt(tags, { tags: { prose: ["prose.sparse", "prose.lush"] } }, undefined, { fill: false });
    expect(one.tags).toEqual(["prose.sparse"]);
  });

  test("naming: a random name adds nothing; a random username and a given name each get a Name section", () => {
    const plain = buildSeedPrompt(tags, { tags: {}, naming: { kind: "name" } }, undefined, { random: seq(0) });
    expect(plain.user).not.toContain("# Name");
    expect(plain.name).toBeUndefined();
    const handle = buildSeedPrompt(tags, { tags: {}, naming: { kind: "username" } }, "A night owl.", { random: seq(0) });
    expect(handle.user).toContain("# Name\nThey go by an online username");
    // The user's guidance comes first; the name comes after the notes.
    expect(handle.user.startsWith("# User guidance\nA night owl.\n\n# Research notes\n")).toBe(true);
    expect(handle.user.indexOf("# Name")).toBeGreaterThan(handle.user.indexOf("# Research notes"));
    const given = buildSeedPrompt(tags, { tags: {}, naming: { kind: "given", name: "Wren" } }, undefined, { random: seq(0) });
    expect(given.user).toContain("# Name\nTheir name is Wren.");
    expect(given.name).toBe("Wren");
  });

  test("Reroll keeps every picked personality", () => {
    const first = buildSeedPrompt(tags, { tags: { personality: ["personality.reserved", "personality.curious"] } }, undefined, { random: seq(0.3) });
    const again = buildSeedPrompt(tags, { tags: { personality: first.tags.filter((t) => t.startsWith("personality.")) }, rolledTags: first.rolled.filter((r) => !r.includes("#")) }, undefined, { random: seq(0.3) });
    expect(again.tags).toEqual(first.tags);
  });
});

// ------------------------------------------------------------ generating

describe("generating a seed", () => {
  const profile = () => app.store.profiles.list()[0]!;
  const api = () => ({ apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 5000 });
  const prompt = () => buildSeedPrompt(loadTags(), { tags: {} });

  test("one call; the header is built in code", async () => {
    fake.replies.push({ content: GOOD });
    const p = prompt();
    const seed = await generateSeed(api(), profile(), p, { source: "generated", avoidTerms: [] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(seed.header).toMatchObject({ name: "Margo", pronouns: "she/her", source: "generated", tags: p.tags, rolled: p.rolled, pockets: p.pockets, model: profile().model, seed_version: 2 });
    expect(seed.header.id).toMatch(/^kw_/);
    expect(parseSeed(seed.text).body.split("\n").filter((l) => l.startsWith("## "))).toEqual(SEED_HEADINGS.map((h) => `## ${h}`));
  });

  test("an avoid term is rejected and retried; the second try passes", async () => {
    fake.replies.push({ content: GOOD.replace("References to books", "Tweet-sized references to books") }, { content: GOOD });
    const seed = await generateSeed(api(), profile(), prompt(), { source: "generated", avoidTerms: ["tweet"] });
    expect(fake.requests).toHaveLength(2);
    expect(seed.header.name).toBe("Margo");
  });

  test("failing twice (a lowered word cap) is a readable error, after exactly one retry", async () => {
    fake.replies.push({ content: GOOD }, { content: GOOD });
    let generation: any;
    const error = await generateSeed(api(), profile(), prompt(), { source: "generated", avoidTerms: [], words: { min: 10, max: 100 }, record: (g) => (generation = g) }).catch((e) => e);
    expect(error).toBeInstanceOf(SeedError);
    expect(error.message).toMatch(
      /^Their seed didn't come out right, twice\.\nFirst try: It's \d+ words; it should be 10 to 100\.\nSecond try: It's \d+ words; it should be 10 to 100\.\nTry again for someone new\.$/,
    );
    expect(fake.requests).toHaveLength(2);
    expect(generation.attempts.map((a: any) => a.problems[0].check)).toEqual(["length", "length"]);
  });

  test("the reply is read forgivingly: bold keys, a code fence", () => {
    expect(parseReply("```markdown\n**name:** Ines\n**pronouns:** they/them\n\n## Who they are\nx\n```")).toEqual({ name: "Ines", pronouns: "they/them", body: "## Who they are\nx" });
  });

  test("Working notes are dropped, even when they mention a name or use ## headings", () => {
    const notes = "### Working notes\n- Discord: Authority, blended with Lurker.\nname: maybe Rowan?\n## Wants\n- scratch\n\n";
    expect(parseReply(`${notes}name: Ines\npronouns: they/them\n\n## Who they are\nx`)).toEqual({ name: "Ines", pronouns: "they/them", body: "## Who they are\nx" });
    expect(parseReply(`## Working notes\nrough\n\nname: Ines\npronouns: they/them\n\n## Who they are\nx`)).toEqual({ name: "Ines", pronouns: "they/them", body: "## Who they are\nx" });
  });

  test("a full reply with Working notes passes every check", async () => {
    fake.replies.push({ content: `### Working notes\n- Reserved: Deliberate.\n- Want: one finished story.\n\n${GOOD}` });
    const seed = await generateSeed(api(), profile(), prompt(), { source: "generated", avoidTerms: [] });
    expect(seed.header.name).toBe("Margo");
    expect(seed.body).not.toContain("Working notes");
  });

  test("the route: a valid seed, then Show prompt and Raw output in dev mode", async () => {
    fake.replies.push({ content: GOOD });
    const { status, data } = await call("POST", "/api/seeds/generate", { tags: { social: "social.discord" }, pockets: { "social.discord": "moderator" } });
    expect(status).toBe(200);
    expect(data.header.tags).toContain("social.discord");
    expect(data.header.pockets).toContain("social.discord#moderator");
    expect(data.header.rolled).not.toContain("social.discord");
    const last = (await call("GET", "/api/seeds/last")).data.generation;
    expect(last.user).toContain("## Primary social media: Discord");
    expect(last.attempts[0].raw).toBe(GOOD);
    // …and it flows into Accept.
    app.store.appState.set("setup.pending", "1");
    expect((await call("POST", "/api/setup", { seed: data.text })).status).toBe(200);
    expect(app.store.seeds.get()!.seed.header).toMatchObject({ id: "home", tags: data.header.tags, model: data.header.model });
  });

  test("the route: several personalities as a list; a list for a one-tag category is refused", async () => {
    fake.replies.push({ content: GOOD });
    const { status, data } = await call("POST", "/api/seeds/generate", { tags: { personality: ["personality.warm", "personality.grounded"] } });
    expect(status).toBe(200);
    expect(data.header.tags).toEqual(expect.arrayContaining(["personality.warm", "personality.grounded"]));
    expect(data.header.rolled).not.toContain("personality.warm");
    expect(fake.requests.at(-1)!.messages[1]!.content).toContain("## Personality: Grounded");
    const refused = await call("POST", "/api/seeds/generate", { tags: { prose: ["prose.sparse", "prose.lush"] } });
    expect(refused.status).toBe(400);
  });

  test("the route: a name you give is theirs, whatever the model wrote; a blank one is refused", async () => {
    fake.replies.push({ content: GOOD });
    const { status, data } = await call("POST", "/api/seeds/generate", { tags: {}, naming: { given: "  Wren " } });
    expect(status).toBe(200);
    expect(data.header.name).toBe("Wren");
    expect(parseSeed(data.text).header.name).toBe("Wren");
    expect((await call("POST", "/api/seeds/generate", { tags: {}, naming: { given: " " } })).status).toBe(400);
    expect((await call("POST", "/api/seeds/generate", { tags: {}, naming: "nickname" })).status).toBe(400);
    fake.replies.push({ content: GOOD });
    expect((await call("POST", "/api/seeds/generate", { tags: {}, naming: "username" })).status).toBe(200);
    expect(fake.requests.at(-1)!.messages[1]!.content).toContain("online username");
  });

  test("the route: twice wrong is a 422 with a short error", async () => {
    fake.replies.push({ content: "Sure! Here's someone." }, { content: "name: X" });
    const { status, data } = await call("POST", "/api/seeds/generate", { tags: {} });
    expect(status).toBe(422);
    expect(data.error).toContain("didn't come out right, twice");
    // What was wrong is in the error, not only in dev mode.
    expect(data.error).toContain("First try: It has no name. It has no pronouns.");
    expect(data.error).toContain("Second try:");
    // …and what it needed beside what each try wrote, for "What they wrote".
    expect(data.expected).toEqual(expect.arrayContaining([expect.stringContaining("350 to 750 words")]));
    expect(data.attempts.map((a: any) => a.raw)).toEqual(["Sure! Here's someone.", "name: X"]);
    expect(data.attempts[0].problems).toContain("It has no name.");
    expect((await call("GET", "/api/seeds/last")).data.generation.attempts).toHaveLength(2);
  });
});

// ------------------------------------------------------- the model to use

describe("the generator profile", () => {
  test("the one marked 'Use for creating kinwriters' (only one can be), else the default; never a roulette", async () => {
    const [first] = app.store.profiles.list();
    const strong = app.store.profiles.create({ name: "Strong", model: "strong/model", temperature: 0.7, reasoningEffort: "high" });
    const other = app.store.profiles.create({ name: "Other", model: "other/model" });
    expect(app.store.profiles.kinwriterMaker(app.store.getSettings().oocAssignment).id).toBe(first!.id);
    // A roulette for OOC: still the first profile.
    const roulette = app.store.profiles.createRoulette({ name: "Mix", entries: [{ profileId: other.id, weight: 1 }] });
    app.store.updateSettings({ oocAssignment: `roulette:${roulette.id}` });
    expect(app.store.profiles.kinwriterMaker(app.store.getSettings().oocAssignment).id).toBe(first!.id);
    app.store.updateSettings({ oocAssignment: `profile:${other.id}` });
    expect(app.store.profiles.kinwriterMaker(app.store.getSettings().oocAssignment).id).toBe(other.id);
    await call("PATCH", `/api/profiles/${strong.id}`, { kinwriterMaker: true });
    await call("PATCH", `/api/profiles/${other.id}`, { kinwriterMaker: true });
    expect(app.store.profiles.list().filter((p) => p.kinwriterMaker).map((p) => p.name)).toEqual(["Other"]);
    await call("PATCH", `/api/profiles/${strong.id}`, { kinwriterMaker: true });
    // Its own samplers and reasoning apply.
    fake.replies.push({ content: GOOD });
    await call("POST", "/api/seeds/generate", { tags: {} });
    expect(fake.requests.at(-1)).toMatchObject({ model: "strong/model", temperature: 0.7 });
    expect(JSON.stringify(fake.requests.at(-1))).toContain("high");
  });
});

// --------------------------------------------------------- from an idea

describe("Generate from idea", () => {
  const tags = loadTags();

  test("tags Jev finds obvious are used; the rest is your words alone", async () => {
    const decider = {
      enabled: () => true,
      ask: async (_state: string, questions: any[]) =>
        new Map(
          questions.map((q) => {
            const selected = q.id === "prose" ? "Lyrical" : "none";
            return [q.id, { id: q.id, selected, probabilities: { [selected]: 0.95 }, confidence: 0.95 }];
          }),
        ),
    } as any;
    const { selection, picked } = await ideaTags(tags, "A poet who writes by ear.", decider, 0.8);
    expect(picked).toEqual(["prose.lyrical"]);
    const prompt = buildSeedPrompt(tags, selection, "A poet who writes by ear.", { fill: false });
    expect(prompt.tags).toEqual(["prose.lyrical"]);
    expect(prompt.rolled).toEqual([]);
  });

  test("nothing obvious (or no Jev): one to three tags rolled, from different categories", async () => {
    for (const r of [0, 0.5, 0.99]) {
      const { selection } = await ideaTags(tags, "Someone fun.", null, 0.8, () => r);
      const prompt = buildSeedPrompt(tags, selection, "Someone fun.", { fill: false, random: () => r });
      expect(prompt.tags.length).toBeGreaterThanOrEqual(1);
      expect(prompt.tags.length).toBeLessThanOrEqual(3);
      expect(new Set(prompt.tags.map((t) => t.split(".")[0])).size).toBe(prompt.tags.length);
      for (const t of prompt.tags) expect(prompt.rolled).toContain(t);
    }
  });

  test("tags you attach are kept; Jev is asked only about the categories you left open, and nothing is rolled", async () => {
    let asked: string[] = [];
    const decider = {
      enabled: () => true,
      ask: async (_state: string, questions: any[]) => {
        asked = questions.map((q) => q.id);
        return new Map(
          questions.map((q) => {
            const selected = q.id === "prose" ? "Lyrical" : "none";
            return [q.id, { id: q.id, selected, probabilities: { [selected]: 0.95 }, confidence: 0.95 }];
          }),
        );
      },
    } as any;
    const chosen = { tags: { personality: ["personality.reserved", "personality.curious"], social: "social.twitter-2010s" }, pockets: { "social.twitter-2010s": "writers" } };
    const { selection, picked } = await ideaTags(tags, "A poet who writes by ear.", decider, 0.8, Math.random, chosen);
    expect(asked).not.toContain("personality");
    expect(asked).not.toContain("social");
    expect(picked).toEqual(["prose.lyrical"]);
    const prompt = buildSeedPrompt(tags, selection, "A poet who writes by ear.", { fill: false });
    expect(prompt.tags.sort()).toEqual(["personality.curious", "personality.reserved", "prose.lyrical", "social.twitter-2010s"]);
    expect(prompt.rolled).toEqual([]);
    expect(prompt.pockets).toEqual(["social.twitter-2010s#writers"]);

    // With no Jev, what you attached is all there is: no tags are rolled on top.
    const alone = await ideaTags(tags, "Someone fun.", null, 0.8, () => 0.99, { tags: { prose: "prose.sparse" } });
    expect(buildSeedPrompt(tags, alone.selection, "Someone fun.", { fill: false }).tags).toEqual(["prose.sparse"]);
  });

  test("the route takes attached tags", async () => {
    fake.replies.push({ content: GOOD });
    const { status, data } = await call("POST", "/api/seeds/idea", { text: "A retired stage actor.", tags: { personality: ["personality.reserved"], prose: null }, pockets: {} });
    expect(status).toBe(200);
    expect(data.header.tags).toContain("personality.reserved");
    expect(data.header.rolled).not.toContain("personality.reserved");
    expect(fake.requests.at(-1)!.messages[1]!.content).toContain("## Personality: Reserved");
    expect((await call("POST", "/api/seeds/idea", { text: "x", tags: "nope" })).status).toBe(400);
  });

  test("the route: source prompted, your words as the guidance", async () => {
    fake.replies.push({ content: GOOD });
    const { status, data } = await call("POST", "/api/seeds/idea", { text: "A retired stage actor." });
    expect(status).toBe(200);
    expect(data.header.source).toBe("prompted");
    expect(fake.requests.at(-1)!.messages[1]!.content).toContain("# User guidance\nA retired stage actor.");
  });
});

// ---------------------------------------------------------- dev tools

describe("dev tools", () => {
  test("Roll 5: five seeds side by side, nothing saved", async () => {
    for (let i = 0; i < 5; i++) fake.replies.push({ content: GOOD });
    const { data } = await call("POST", "/api/seeds/roll5", { tags: {} });
    expect(data.seeds).toHaveLength(5);
    expect(data.seeds.every((s: any) => s.header?.name === "Margo")).toBe(true);
    expect(app.store.seeds.get()).toBeNull();
  });

  test("Check files and a tag file for Trace", async () => {
    expect((await call("GET", "/api/seeds/check-files")).data).toMatchObject({ problems: [], checked: 34 });
    const { data } = await call("GET", "/api/seeds/tag-file?id=social.reddit");
    expect(data.file).toBe("kinwriter-tags/social/reddit.md");
    expect(data.text).toContain("## Pockets");
  });

  test("none of them exist outside dev mode", async () => {
    app.store.close();
    app = createApp(testConfig(dir.path, fake.baseUrl));
    for (const [method, path] of [
      ["GET", "/api/seeds/last"],
      ["POST", "/api/seeds/roll5"],
      ["GET", "/api/seeds/check-files"],
      ["GET", "/api/seeds/tag-file?id=social.reddit"],
      ["GET", "/api/developer"],
    ] as const) {
      expect((await call(method, path, method === "POST" ? { tags: {} } : undefined)).status).toBe(404);
    }
    expect((await call("GET", "/api/seeds/defaults")).data.test).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});
