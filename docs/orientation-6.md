# Orientation stage 6: characters and the starter scene

Two new steps in the version together, after the opener: **characters** and **a starter scene**. The version on their own gets the characters step, worded for being alone.

## Characters (yours, theirs, shared)

**Your card** has a small form:
- your character's name;
- a line or two;
- one secret only you know.

This makes:
- your character, with the line or two as its "About";
- a separate lore entry, "Kestrel's secret", hidden from your kinwriter with the notebook's own visibility. The notebook has no per-field secrets, so the secret is its own entry.

**Their part:** they make their character with `create_notebook_entry`, and a secret entry with `hidden_from_user`.

**Both of you are told plainly that the other has one.**
- Their step says your character has a secret they can't see or find.
- Your card counts their secrets ("Wren is keeping a secret") but never names them: the server only counts their hidden entries.
- Shared lore is the bridge: changes to it go through the other's approval, as always.

Keep both small: a name, a line or two, one secret. Everything made during an orientation is known by its creation time, which is how the choices at the end (stage 9) can keep or discard it.

## The starter scene

When this step begins, a story channel is made, `#first-scene` (or `#first-scene-2` and so on, if taken), with both characters in its cast.
- **Their part** happens there (`step-scene-where: scene`): they write its opening post, keeping their secret.
- **The app takes you there** when you press Next, and the orientation panel shows in it too.
- **You write a few posts back and forth.** The scene channel is part of the orientation: you can write there, and their replies carry the guide. Your other channels still wait.

It gives later lessons real material: a message to edit, lore to change, a channel to link.

## Wording on their own

A step section with `-alone` on the end wins in the version on their own. `step-characters-kinwriter-alone` doesn't say you're making a character too, because you aren't there. The rule throughout: the prompt must never describe something that isn't happening.

## API and data

- `POST /api/orientation/character` with `{ name, about, secret }`.
- `GET /api/orientation` adds:
  - `made: { yours, theirs, yourSecrets, theirSecrets }`. Their secrets are a count only.
  - `session.scene`, the starter scene's channel.
- A step can have `step-<id>-where` (`practice` or `scene`). The orientation's channels are #practice and the scene; the feed, the lock on other channels and the guide in their prompt cover both.

**Tests:** the version together, step by step:
- both characters, with each secret kept from the other side;
- the scene channel, its cast and their opening post;
- you writing there while OOC waits;
- then the tools step and the closer.

The version on their own checks the `-alone` wording.
