# Kinwriter generation

Every new kinwriter can now begin as a **seed**: a short profile in a fixed format. You pick a ready-made one, make a new one from tags, or generate one from your own idea. You see them before they're made, and the seed becomes the first draft of their **self-notes**, which they rewrite in their own words during orientation. The design is in [`design/kinwriter-generation/`](../design/kinwriter-generation/), with `spec.md` as the source of truth.

## Making someone

In the first-run setup, or when you make a new kinwriter (**+** in the rail, or **Add a kinwriter here**), press **✨ Choose or make someone…**. The seed picker (`public/js/seeds.js`) offers:

- **The default kinwriters**, as cards (name, pronouns, tagline), from `kinwriter-defaults/`. The folder ships empty, so for now there are none.
- **Make a new one**: five categories (Personality, Temperament, Prose style, Biggest influence, Primary social media), each starting on "Surprise me". Primary social media's subtitle, *i promise this option is interesting*, opens a details page with each platform's era and tics.
  - **Advanced** (folded away): once you pick a platform or an influence, you can choose its corner (a pocket). Otherwise one is rolled.
  - **Surprise me, don't show me** skips the preview: they're made at once, and you meet them in orientation.
- **Generate from idea**: write as much or as little as you like. Jev reads it for tags it obviously suggests. If none stand out, one to three tags are rolled. Everything else comes from your words, which win wherever they disagree with a tag. Its seed says `source: prompted`.

Writing who they are yourself still works, in the same form as before. That kinwriter has no seed.

**The preview** shows their name, pronouns and seed. The tags are chips, with 🎲 on the ones chance picked; a corner you chose shows as a small chip under its tag, while a rolled one stays hidden.
- **Reroll**: the same tags and chosen corners, a new person.
- **Reroll the dice**: rolls only what chance picked. It shows only if chance picked something.
- **Back to tags**: back to the picker, with your choices kept.
- **Edit**: name, pronouns and the text. Saving checks the headings again (not the length) and marks the seed `user_edited`.
- **Accept**: makes them, and the app offers their orientation.

A default gets the same preview, without the rerolls.

## The seed

`src/seeds.ts`. A seed is a Markdown file: a header for code (`id`, `name`, `pronouns`, `source`, `tags`, `rolled`, `pockets`, `model`, `created`, `seed_version`, plus `user_edited`, and `tagline` for defaults), and a body with nine headings, in order: Who they are, Wants, Off the page, In OOC, On the page, Voice, Contradictions, Leanings, Left open. Code reads only the header. This is `seed_version: 2`; version 1 seeds (seven headings, with Tension and no Wants or Off the page, 250 to 450 words) still read, and are checked against their own headings.

On Accept, the kinwriter gets their own id (their hub id, written into the seed's header). The seed is kept as it was, read-only, in their database (`seed` table, migration 12). Their self-notes start as a copy of its body.

## The generator

`src/generator.ts`: one prompt-assembly function and one call.

1. `buildSeedPrompt` fills every "Surprise me" category at random, then rolls a pocket for each tag that has them (unless you chose one), and records what chance picked.
2. It assembles the user message:
   - **Your idea first:** under `# User guidance` ("None." if there isn't one), so it frames the notes instead of arriving last and overwriting them.
   - **Each tag:** its fragment, without its Pockets section, under `## <category>: <label>`.
   - **Its pocket:** the chosen or rolled pocket's bullets, under `### This person's corner`.
   - The fragments' own `##` headings move down to `###`, so they sit under their tag's heading.
3. The system prompt is `kinwriter-generator/system-prompt.md`, rewritten in October 2026 for more vivid kinwriters: the model starts with rough Working notes (what each tag's history left this person with, which of its Ways it can go fits, how they'd use the app's tools, and what they want), then writes the seed. It's told to keep contradictions, give them wants and a life off the page, write people who aren't agreeable by default, leave safety to the app, and start them with no built-in feelings about you. Edit it to tune generation; no code change is needed.
4. One call, with the profile marked **Use for creating kinwriters** (Settings → Profiles). Only one profile can have it on. With none checked, the default is used: the profile OOC is assigned to, or the first profile if OOC uses a roulette. A roulette is never used. The profile's own samplers and reasoning setting apply.
5. The Working notes are dropped (dev mode's Raw output still shows them). The reply's `name:` and `pronouns:` lines and body are read, and the header is built in code. The call allows at least 4000 tokens, since the notes and the seed run long together.
6. **The checks:**
   - name and pronouns are there;
   - the nine headings are there, in order, with exact text;
   - the body is 350 to 750 words;
   - two or three Left open bullets;
   - a dosage word (rarely, occasionally, regularly or often) in every Voice bullet;
   - none of any tag file's `avoid_terms`, as whole words or phrases, in any case.

   If it fails, it tries once more with the same inputs. A second failure shows a short error with **Try again**.

## Tag files

`kinwriter-tags/<category>/<slug>.md`, one per option, converted from the fragment docs. Since the October 2026 overhaul, the tag files are the working copy; the fragment docs in `design/kinwriter-generation/` keep the original research and sources. There are 34: 10 personality, 4 temperament, 6 prose, 6 influences, 8 platforms. `src/tags.ts` reads them fresh each time, so adding, changing or deleting a file changes the picker and the details page with no code change. Only the five categories and their order are fixed in code.

The header holds `id`, `category`, `label`, `blurb`, `order` and `avoid_terms`. The body holds the fragment's sections as `##` headings: Era (platforms only), Texture, Ways it can go, On the page, In OOC, Tics, Avoid and Tension hooks. Platforms and influences end with `## Pockets`. Each pocket is an `###` slug with `label:` and `blurb:` lines, then bullets: what happened there, "On the page", "In OOC".

How fragments are written (since the October 2026 overhaul):

- **Texture** describes what happened or what the trait is like day to day, with no verdict about who they became. "Held permissions other people didn't" leaves the generator room; "became a calm mediator" decides for it.
- **Ways it can go** lists four or five different people the same history or trait can leave (for Discord: Keeper, Architect, Authority, Regular, Lurker). The generator picks one or blends two to fit the other tags and your guidance.
- **On the page** and **In OOC** are pools to draw from, not checklists, and include habits that show up in how they use the app's tools.
- **Avoid** names the caricatures, including the dark side of each Ways it can go option (the power-tripping mod, the brooding mystery act). It doesn't sum up what the tag "gave them".
- **Pockets** describe the corner as experiences, and where a corner can go two ways, say so.
- Same rules as before: no "the X is the Y" or "not X, but Y", tics carry a dosage, and nothing tells them to quote you.

A file that doesn't load is skipped, with a warning in the log, except in dev mode, where it stops the picker until it's fixed.

## Self-notes

Their self-notes are their identity (`src/identity.ts`), not a second store: who they are and their tastes, with every version kept, and in their prompt every turn. Their seed never goes into their prompt. What's new (`src/selfnotes.ts`):

- **Private by default.** Their page says they're private and offers **Ask to read them**. Your request reaches them on their next turn, and they decide with `share_self_notes`. They can stop sharing at any time. While they're shared, you can read them on their page, as `self.md` with a small header (`id`, `name`, `pronouns`, `derived_from`, `last_revised`, `shared_with_user`), and in the kinwriter menu. You can't change them.
- **Your suggestions to their identity are gone**, because their self-notes are theirs. Suggestions made before stay theirs to answer, and yours to withdraw.
- **Kinwriters who already existed** start shared (migration 13), since you could always read theirs, and they're told once that they can stop.
- **While private**, nothing in the app shows them. "Preview prompt" and the dry run show a placeholder, `revise_identity` keeps its text out of the tool log, and the app's settings leave them out.
- **Dev mode** can always read them, without telling them (their standing notes disclose this).
- **A soft cap of about 800 words**: from 700, they're asked to condense instead of adding.
- **Their seed.** They can read it any time, with `read_my_seed` or first in `read_identity_history`.

**A new name.** `request_name_change({ name, reason? })` puts a card in your inbox ("Call them Margot?"). Approving changes their name everywhere, their self-notes' header included. Their next turn hears how it went, and asking again while one is waiting replaces it.

## The orientation handoff

`src/handoff.ts`, wording in `defaults/seeds.md`. While their self-notes are still the seed's draft:

- **Together:** from the first step, they're told it's a starting draft of who they are, written before they existed: keep what fits, change what doesn't, and rewrite it in the first person by the end. The interview lists their Left open questions to explore with you. In the write-up, they rewrite it, with the suggested headings (Who I am, What I want, Off the page, In OOC, On the page, Voice, Contradictions, How I like to work, Still figuring out), and their Leanings become choices, such as `set_my_proactivity`.
- **On their own:** the same, alone. Their Left open questions go under "Still figuring out", with a note to bring them up naturally in early OOC.
- **Skipped**, or the rewrite didn't happen: their OOC turns ask them to rewrite it until they do.

The rewrite saves at once, whatever you choose about the orientation's conversation.

## Dev mode

These are all behind `DEVELOPER_PANEL=1`, like the developer panel. Without it, their routes answer 404 and their buttons don't show, and opening them never tells the kinwriter.

- **Load test seed** (the picker): the spec's Margo example (`kinwriter-generator/test-seed.md`), through the same preview and Accept.
- **Show prompt** and **Raw output** (the preview, and the error screen): the last generation's full system prompt and user message, and each attempt's unparsed reply with the checks it failed.
- **Trace** (the preview, and Seed vs. self): the tags, rolled tags and pockets behind a seed, each opening its tag file.
- **Roll 5** (the tags): five seeds from the current choices, side by side. Nothing is saved.
- **Check files** (the picker, and in the log whenever the app starts in dev mode): every tag file (header, sections, pockets' labels and blurbs) and every default seed (the seed checks, a tagline, and tags that exist).
- **Seed vs. self** (their page): their `seed.md` and `self.md` side by side.

## Things the build turned up

- The spec's Margo example says "reads a lot of **literary fiction**", which is one of contemporary fiction's `avoid_terms`. So the example would fail its own check if a model wrote it. The test seed is kept word for word (Accept doesn't check avoid terms), and the tests use a copy without it.
- The old 🎲 Surprise me (`src/rng.ts`, `defaults/surprise.md`) is gone. Generate from idea takes its place, and the kinwriter menu no longer rerolls an existing kinwriter.

## API

| Route | What it does |
| --- | --- |
| `GET /api/seeds/defaults` | The default seeds; in dev mode, the test seed too |
| `GET /api/seeds/tags` | The picker: categories, options, blurbs, pockets, era and tics |
| `POST /api/seeds/generate` | `{ tags: { category: id or null }, rolledTags?, pockets? }`: a seed (422 with a short error after two failures) |
| `POST /api/seeds/idea` | `{ text }`: a seed from your idea |
| `POST /api/seeds/check` | `{ text }`: an edited seed's headings, name and pronouns |
| `POST /api/seeds/parse` | `{ text }`: a seed file, read |
| `POST /api/setup`, `POST /api/hub/servers`, `POST /api/hub/servers/:id/friends` | Accept `seed` (the seed's text) to make a kinwriter from it |
| `POST /api/self-notes/request`, `POST /api/self-notes/request/withdraw` | Ask to read their self-notes, or take it back |
| `GET /api/seeds/last`, `POST /api/seeds/roll5`, `GET /api/seeds/check-files`, `GET /api/seeds/tag-file?id=` | Dev mode only |

`GET /api/state` and the kinwriter page include `selfNotes: { shared, request, fromSeed, draft, words, cap, file, pronouns }`. `file` and the page's `identity` and `history` are only filled in while shared. Profiles have `kinwriterMaker`. The settings have `friendPronouns`.

New tools: `share_self_notes`, `request_name_change`, `read_my_seed`.

## Tests

- `test/seeds.test.ts`: the seed format and its checks, Accept, self-notes (private, asked, declined, shared, withdrawn, from before, the cap), the orientation handoff on every path, and a new name.
- `test/generator.test.ts`: tag files and Check files, the picker changing with the files, `buildSeedPrompt`, generating (one call, an avoid term retried, two failures as an error), the generator profile, Generate from idea, and the dev tools, none of which exist outside dev mode.

In a real browser, on desktop and phone sizes, against a fake model:

- the picker, tags, Advanced, the details page and the preview;
- Reroll, Reroll the dice, Edit (a broken heading refused) and Accept;
- the test seed, Generate from idea, Surprise me don't show me, and Roll 5;
- the error screen, with Raw output and Try again;
- a rename in the inbox, private self-notes and Ask to read them, and Seed vs. self.
