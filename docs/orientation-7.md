# Orientation stage 7: the ladder lessons

Five new steps, between the starter scene and the closer:
- **editing**;
- **models and profiles**;
- **the library**;
- **linking channels**;
- **their own instruments**.

They replace the old "trying their tools" step. The version together now has nine steps. The version on their own has six: characters, then the same five lessons.

## How a ladder lesson goes

Each lesson has the guide's five beats:
1. what it is;
2. the ladder, from most collaborative to most direct;
3. what they'll know at each rung;
4. you try;
5. they try, and write a map entry ("I'd reach for this when…", `write_map_entry`).

**Your card** has beats 1 to 4. **Their part** has 1, 3 and 5. It's all wording in `defaults/orientation.md`. The map entry is how a lesson shows. There is no quiz, and nothing tells them they got something wrong.

**You try first.** A step with `step-<id>-after: you` waits for you: their turn doesn't run when the step begins. Your card has **Hand it to {name}**, and their part runs when you tap it.
- Until then, their prompt says the step is yours to try first (`orientation-waiting`). If you talk with them in #practice meanwhile, they know to leave the trying to you.
- **Next** works either way, so any lesson can be skipped.
- On their own, there's nobody to wait for: their part runs at once.

## The lessons

**Editing.** The ladder:
1. talk about a message in #practice, and they edit it;
2. suggest a rewrite: select words in their message, then "✎ Suggest";
3. Edit it yourself.

Their part:
- answer each suggestion with `review_rewrite`;
- keep a craft note (`keep_pattern_note`) if the suggestions show a habit;
- try `edit_my_message`, `delete_my_message` and `read_message_history` on their own messages;
- write "How I'd like feedback" (`write_self_page`, section `feedback`).

On their own, they write a line and then get a turn to change it (`step-editing-followup-alone`).

**Models and profiles.** Your card has the settings table, one plain sentence per setting, with Min P next to Top P. You try "Regenerate with…" on their latest reply in the scene and compare the two versions.
- With only one profile, the card says to make a second one first.

Their part:
- `mark_my_voice` / `flag_not_me`;
- `write_profile_note`;
- `consult` on a real question, if they have a consultant.

The card's point: a profile changes how their words come out, never who they are.

**The library.** Your card has **Add the example** and **Open the library**. Their part is "check whether your memory of this scene is right": say from memory, then search, then tell you what they got right. `{library}` in their part lists what's in the library, so the part is true whatever is there. On their own, the example is added for them when the step begins, if this copy has it.

**Linking channels.** `#channel` in a message is now a chip that opens the channel. A tag in #practice brings that channel's summary into their prompt, or its newest posts if it has no summary yet.
- **Your rung:** tag the scene, and ask for an ending or a starter there.
- **Their part:** `read_channel_summary`, then `post_in_channel`.
- **On their own:** they only read. They're told not to post in your channels while you aren't there to ask.

**Their own instruments.** Tools with no rung for you: `check`, `ask`, `consult`, the journal, wake-ups, drafts and their reflexes (`set_my_reflexes`). They try each one once and write its map entry while you watch the feed. A first draft of their tastes is offered here until the write-up (stage 9) takes it over.

## The library example

The example is Night of the Living Dead (1968). The film is public domain in the US, and the Wikisource transcript is marked public domain.

`bun run fetch-example` (scripts/fetch-library-example.ts) does three things:
1. fetches the transcript from Wikisource;
2. turns its "Name: words" lines into cue lines (the name in capitals, the words under it), which the library reads as speakers;
3. saves `defaults/library/night-of-the-living-dead.md`.

Run it once somewhere with internet and commit the file. Until then, **Add the example** says so plainly, and the library lesson works with whatever is in the library.

## API and data

- `POST /api/orientation/hand-over`: you hand them the step. Their part runs now.
- `POST /api/orientation/library-example`: adds the example, or returns the one already there. If the file is missing, it answers 400 with what to do.
- `GET /api/orientation`: `step.after` and `step.waiting`.
- The session keeps `handed`, reset on each new step.
- In their part, `{scene}` becomes the scene channel (like `#first-scene`), and `{library}` the library's documents.

**Tests:**
- the version together through all nine steps;
- the lesson waiting, their prompt while it waits, and the hand-over;
- the library example's missing-file message;
- instruments listing `set_my_reflexes`.

On their own: the editing follow-up, linking without posting, and something asked during instruments marked as from the orientation. The example file: script conversion, adding it once, open to every channel, with speakers found.
