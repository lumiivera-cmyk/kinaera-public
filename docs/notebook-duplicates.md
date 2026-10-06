# No duplicate notebook entries

Your kinwriter kept making a second lore entry for something already in the notebook instead of looking up the one that was there.

## Why it happened

- **In a story channel, they only saw what was pinned there,** plus what that links to. Lore they made earlier without pinning it was invisible, so as far as they could tell it didn't exist.
- **Nothing stopped a second entry with the same name.**
- **The lore reflex** (`defaults/reflexes.md`) asked Jev whether a draft "introduces a new named character, place or object", but Jev didn't know what was already there. So it kept suggesting `create_notebook_entry` for known names.

## What changed

- **A second entry with the same name is refused.** The name check ignores case, punctuation and a leading "the", so "the Lantern Guild" and "lantern guild" count as the same. Nothing is made, and the existing entry (its fields and notes) comes back instead, with a pointer to `edit_notebook_entry`. Only entries they can see count: one you've hidden from them never blocks theirs, so a refusal can't tell them it exists.
- **"Also in the notebook"** in story-channel prompts lists everything that isn't pinned or linked there, by name and kind only, up to 80 (`search_notebook` finds the rest). They're asked to read an entry before writing about it, and to add to it rather than make a new one. The wording is `notebook-elsewhere` in `defaults/turns.md`.
- **The lore reflex** now gets the names already in the notebook (up to 150). Its question asks only about names not in that list. Its reminder says to add to an existing entry first, and to create one only if it's really new.

## Duplicates already made

These changes don't merge anything. Delete the extra in the notebook yourself, or ask your kinwriter to merge them: `edit_notebook_entry` on the one to keep, then `delete_notebook_entry` on the other.

**Tests** (test/reflexes.test.ts):
- a same-name entry is refused and hands back the existing one;
- an entry hidden from them doesn't block theirs;
- the names-only list appears in a story channel, without details;
- Jev sees the known names.
