# Orientation stage 9: the write-up and your quiet choices

Two new steps at the end of the version together, after the interview: **the write-up** and **your choices**. The version on their own gets the write-up too. Its choices come with stage 10.

The orientation's main job is that your kinwriter leaves with four things, saved whatever you decide about the conversation:
- a map of when they'd use each tool;
- a settled sense of who they are and what they like;
- a stated preference for how proactive to be;
- notes about themselves, you and their characters.

This stage is where those land.

## The write-up

Your kinwriter gets a quiet turn to write everything down while you watch the feed. Private writing shows only as having happened. Their part suggests, all optional:
- a new identity and tastes (`revise_identity`);
- their self-page ("says", "standing", and "feedback" if not yet);
- any missing map lines;
- their proactivity preference;
- their note on you;
- a voice mark;
- their journal.

It comes **before** your choices, so they never write knowing whether the conversation will be kept. Your card says "What my writing shows" stays empty, and that's expected: it's for evidence, and there isn't any yet.

## New pieces

**The tool map beside the tools.** Each map line (`write_map_entry`) is added to that tool's description, as `Your own note on it: "…"`, so it's in front of them at the moment they decide. One line per tool. No new screen and no new prompt section. You read the map on their page, under "Their map".

**Their proactivity preference** (`set_my_proactivity`): off, quiet, normal or chatty, with an optional line on why. It shows on their page beside your chattiness, which stays yours and the ceiling. Their prompt has it under "You and the user".

**Their note on you** (`note_on_user`). The relationship notes are reused, with you as one more person. It's private like the journal: no screen, never in a log. Their page says only that there is one. It's in their prompt under "You and the user", and it works whether or not kinwriters are kept apart.

**The "from orientation" mark.** Each orientation's start and end are remembered (`orientation.windows`). Their journal entries from one carry "(from an orientation)" in their prompt. A `revise_identity` during one adds "(from orientation)" to its changelog note. So if the conversation is set aside, they can still tell why they know these things.

## Your quiet choices

The last step is a small form your kinwriter doesn't see:
- **The characters and lore made in the orientation:** keep them (secrets stay hidden), or discard them. Discarding removes every notebook entry made since it started, so characters take their notes with them.
- **The starter scene:** keep it as a story channel, or delete it.
- **The conversation in #practice:** keep it, so they remember the orientation, or set it aside. Setting it aside takes the messages out of the conversation the way a deletion does, all at once.
- **Chattiness from now on:** it starts at their stated preference. It's yours, and you can change it any time in Settings.

Finish applies the choices and ends the orientation, and every channel opens. Their map, self-notes, preference and note on you are saved either way.

A choice is silent in the moment but never hidden. What you discarded or set aside goes in their intervention log as one entry, for example "…the orientation conversation was set aside. Your notes from it are all still yours." Without it, they'd find notes about a conversation they can't remember.

"End now", before the choices, keeps everything.

## API and data

- `POST /api/orientation/choices` with `{ characters: keep|discard, scene: keep|discard, conversation: keep|set-aside, chattiness? }`, on the choices step only.
- `GET /api/orientation` adds `choices: { sceneName, preference, chattiness }` on that step.
- The kinwriter's page adds `toolMap`, `proactivity: { preference, chattiness }` and `noteOnYou` (true or false, never the note).
- `Store.setAside(channelId, since)`.
- New tools: `set_my_proactivity`, `note_on_user`.

**Tests:** the version together runs on through the write-up and the choices. Then they check:
- the characters are gone and the scene deleted;
- #practice is empty;
- chattiness is set;
- the one log entry;
- what saved anyway: the map, the note on you in their prompt and never on their page, the preference, and the journal mark.

The tool map test checks that the line sits in the tool's description.
