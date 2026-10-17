# Scratchpads

Every story channel has scratchpads: freeform notes for that storyline, kept out of the notebook. Details, where everyone is standing, secrets, threads to pick up, notes on a character or a place. Nothing in them is lore until someone puts it in the notebook.

## Three per story channel

| Pad | Who reads it | Who writes it | In your kinwriter's prompt |
| --- | --- | --- | --- |
| **Shared** | You and your kinwriter | Both of you | Yes, in that channel |
| **Just mine** | You | You | Never |
| **Theirs** | Your kinwriter | Your kinwriter | Yes, in that channel |

Only story (roleplay) channels have them. OOC channels don't, but your kinwriter can read and write a story's pads from OOC by naming the channel.

## Using them

- Tap the **notepad** at the top of a story channel. **Shared** and **Just mine** are tabs.
- It works like a shared document. What you type saves itself a moment after you stop (and when you switch tabs, press **Done**, or close it). While it's open, it checks every few seconds for your kinwriter's changes and shows them. Under the box: whether it's saved, who changed it last, and when.
- **Undo last change** puts back the version before the last change, whoever made it (yours or your kinwriter's). Pressing it again redoes.
- If your kinwriter writes while you're mid-change, both are kept: your save is merged with theirs, line by line. Where you both changed the same line differently, yours comes first, then theirs.
- **Save to notebook…**: select some text, press it, and choose **a new entry** (a name, lore or character, pinned to the channel by default) or **add to an entry** (any you can edit; on one you can only suggest changes to, it's a suggestion). It goes in a field (by default Details for lore, Background for a character), after what's already there, and leaves the pad unless you tick **Keep it in the scratchpad too**. Undo puts it back in the pad (the entry stays).
- Under **Just mine**, a line says whether your kinwriter keeps a private pad there too. What it says is theirs.

## Your kinwriter's side

Their prompt in a story channel has a **Scratchpad** section after the notebook: a line on what it's for, then the shared pad and their own, in full, each with who changed it last. Empty pads still show (as "(empty)") when they can use tools, so they know they're there. The wording is in `defaults/scratchpad.md`, and editable in Settings → Prompts.

| Tool | Does |
| --- | --- |
| `write_scratchpad` | Writes in the shared pad. By default `text` is added as a new line; with `find`, it replaces that exact passage (empty `text` removes it); with `how: "replace"`, it becomes the whole pad. `channel` names another story channel (needed from OOC). |
| `write_private_scratchpad` | The same, on their own pad. |
| `read_scratchpad` | Both of a story channel's pads (shared and theirs), for reading another channel's from OOC. |
| `scratchpad_to_notebook` | Saves a `passage` of a pad (`pad`: shared or private) to the notebook: added to an existing `entry` by name, or a new one (`kind`, `pin`). `field` and `keep` as in the app. A new entry from their private pad starts hidden from you. Private, since it can carry their pad's text. |

They're told about scratchpads once, as a notice, on their first turn with tools after this was added (`introduction` in `defaults/scratchpad.md`).

## Privacy

- **Yours** is never in their prompt, and no tool reads it.
- **Theirs** is private like their journal and drafts: the tool log keeps that a private tool was used, never what it wrote or read, and its summary never quotes it. The prompt preview shows "(private)" in its place. The app only shows whether it has anything in it.
- The **developer panel** (`DEVELOPER_PANEL=1`) shows their private pads, under "Private scratchpads". That's disclosed to them with the rest of their private notes (`developer` in `defaults/standing.md`).

## How it works

`src/scratchpads.ts`. Each pad is one value in `app_state`, `scratchpad:<channel id>:<shared|user|kinwriter>`, as JSON: its text, who changed it last and when, how many times it's been changed (`rev`), and the version before (for undo). So there's no migration. A pad holds up to 12,000 characters (about 2,000 words); past that, a write is refused with a suggestion to tidy up or move what's settled into the notebook. Deleting a channel deletes its pads.

A save from the app sends the text it started from (`baseText`), and the server merges it with the pad as it is now (`mergeText`, a line-by-line three-way merge), so changes made meanwhile are kept. A write can instead name the `rev` it started from (`base`): if the pad has changed since, it's refused (409 from the API).

Saving to the notebook (`toNotebook`) goes through the notebook's own permissions, as you or as your kinwriter, so whatever either of you may only suggest becomes a suggestion.

## API

- `GET /api/channels/:id/scratchpads`: `{shared, mine, theirs: {written}, limit}`. Each pad is `{text, by, at, rev, previous}`, with `by` `"user"` or `"kinwriter"`.
- `PUT /api/channels/:id/scratchpads/:pad` with `text`, and `baseText` (merged with changes since) or `base` (refused if changed since). `pad` is `shared` or `mine`.
- `POST /api/channels/:id/scratchpads/:pad/to-notebook` with `passage` (and `index`, where it starts), then `entryId`, or `name`, `kind` and `pin`; optionally `field` and `keep`. Returns the pads and `saved`: `{entry, created, suggested, pinned}`.
- `POST /api/channels/:id/scratchpads/:pad/undo`.

Only story channels: any other is a 400.

## Tests

`test/scratchpads.test.ts`: merging, saving to the notebook (new, added to, hidden from their private pad, from the app and their tool), undo, refusing a write from a stale version, the length limit, deletion with the channel; the three tools and their mistakes, from a story channel and from OOC; the prompt (in story channels only, empty pads shown, theirs hidden from the preview, the one-time notice); their pad kept out of the tool log and your view; and the API.
