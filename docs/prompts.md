# Prompts and dry run

Every instruction your kinwriter's model gets is in one place: **Settings → Prompts and dry run…**. You can also get there from **Preview prompt → Dry run…**.

## Wording

Kinaera writes its prompts from the files in `defaults/`. Each file is split into `## name` sections. The **Wording** tab lists every section of every file, with a search box. Edit a section and press **Save**, and it's used from the next turn on. **Reset to default** brings the original back.

The files:

| File | What it holds |
| --- | --- |
| `turns` | The framing of every turn: who they are in roleplay and OOC, the literary and casual styles, texting, the notes that end a conversation when you haven't written, why they're up on a turn of their own, comment replies, the cast, the library |
| `standing` | "Good to know": honest notes on how things work here |
| `instruments` | `check`, `ask` and `consult` |
| `orientation` | Orientation, the practice channel and the weekly look back |
| `time` | Wake-ups they schedule, the heartbeat, drafts, pausing a storyline |
| `continuity`, `wellbeing` | Staying themselves across models, and the weekly reading |
| `friends`, `permissions`, `retirement` | Other kinwriters, standing permissions, archiving |
| `summaries` | How summaries and channel digests are written |
| `surprise` | 🎲 Surprise me |
| `jev` | The fallback when Jev, the decision model, is unavailable |
| `practice` | The practice notes in the practice channel |

**Where your edits live.** They're in `data/prompts.json`, apart from `defaults/`. Each edited section wins over its default, one section at a time. So `git pull` never clashes with your edits, and an update that improves a section you haven't touched still reaches you. Saving a section's default text is the same as resetting it. Edits are shared by every kinwriter, and `bun run fresh` keeps them.

**Placeholders** like `{name}` or `{time}` are filled in by Kinaera. Each file's note (shown above its sections) says which ones it uses. Keep them where you want the value to appear. A placeholder Kinaera doesn't know is left as it is.

**What isn't here:**

- **Who your kinwriter is, and how they write** in literary, casual and OOC. Those are theirs, per kinwriter, in their menu (Kinwriter…). The files `defaults/friend.md`, `literary.md`, `casual.md`, `ooc.md`, `tastes.md` and `character.md` are only starting values for a new kinwriter and the example character, so they aren't on this screen.
- **Tool descriptions.** They're part of the tools in `src/tools.ts`. The dry run shows them all.
- **Small generated lines**, like how long ago something was, or a list of reactions.

## Dry run

The **Dry run** tab shows what a turn would send without taking one. Choose:

- **The kind of turn:**
  - a turn now (like Kinwriter's turn, or a reply to what's there);
  - any wake-up: opened, back after a while, scene ended, review, answer, heartbeat, a scheduled wake-up;
  - orientation, or the weekly look back, which are always in the practice channel;
  - the last turn before archiving.
- **The channel.** Choosing a wake-up moves it to OOC, where those happen, but you can pick another.
- **Who writes it:** the channel's usual profile or roulette, or any profile.

**Build prompt** shows:
- the system prompt, folded by section, with its size;
- the conversation, ending with the note that asks for the turn;
- every tool offered, with what the model is told about each.

This is built by the same code as a real turn, with the wording as it is now. So you can edit a section, then build again and see the change.

**Ask the model** also sends that request to the model once, and shows what they'd write and which tools they'd call. It costs one request. The tools aren't run, so it stops there: a real turn would go on to run them and continue. Nothing is saved, nothing is posted or delivered, and nothing counts as a turn or a wake-up.

**Privacy.** As in Preview prompt, the screen never shows:
- journal entries (the look back's included);
- draft titles;
- their notes on other kinwriters;
- what a private tool was called with.

The model gets the real prompt, as it would in a turn. A DM you chose not to see can't be dry-run.

## API

- `GET /api/hub/prompts`: every file, with `about`, and each section's `text`, `defaultText` and `edited`.
- `PUT /api/hub/prompts/:file/:section` with `{ text }` saves an edit. `DELETE` resets it.
- `POST /api/dry-run` (on a kinwriter's app) with `{ turn, channelId, profileId?, send? }`. `turn` is `"turn"` or a wake reason. It returns:
  - `channel` and `profile`;
  - `messages`, with private things replaced;
  - `tools`;
  - with `send`, `reply`: `{ content, toolCalls }`.
