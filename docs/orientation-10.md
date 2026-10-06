# Orientation stage 10: the version on their own

The returning version, for a kinwriter whose user has been through the full version before. Your kinwriter goes through orientation alone. It only runs when you pick it. Its steps are in `steps-returning`:

1. characters
2. scene
3. editing
4. profiles
5. library
6. linking
7. instruments
8. questionnaire
9. writeup
10. choices

## What they do

**Their character,** with a secret, as in the version together.

**A practice scene** (`defaults/practice-scene.md`): a short story channel, `#practice-scene`, with a canned partner standing in for you, Ines Corrow. Her posts were written ahead of time, and their part says so plainly: she won't react to what they write.
- Her first post is there when the step begins. They reply.
- Her second post comes in, and they reply again (the step's follow-up).
- The partner is a notebook entry of yours, the "yours" column, in the scene's cast.

**The kinwriter half of every ladder lesson,** worked against the practice scene:
- editing their post there;
- marking their voice on it;
- linking, by reading it and posting a short ending there with `post_in_channel`. They're told never to post in your own channels while you're away.

The library lesson uses the Night of the Living Dead text, added for them when the step begins, if this copy has it.

**The questionnaire:** the interview, on their own.
- They answer your cards (`for-kinwriter`) in a message in #practice for you to read later. Any card can be skipped, or kept with `keep_to_myself`.
- They pick the questions they'd like to ask you, from their cards or their own, with `save_questions_for_user` (up to 10). When the orientation ends, those arrive as their message in OOC, and you answer whenever you like.

**The write-up,** as in the version together.

## What you see: tool bingo

While they go, the panel in #practice, and their page, shows a bingo card of their tools, one per square. A square fills when the feed shows them using that tool.
- Private tools fill squares too, without what was written.
- A reflex reminder is Jev's, not theirs, so it fills nothing.
- A tool offered only on one step (like `save_questions_for_user`) keeps its square once used.
- There are no model calls.
- A line counts what they've tried and how many secrets they're keeping, once their character is made.
- The card folds away.

## Only one kinwriter is locked out

Only the kinwriter who is orienting is unavailable. Each kinwriter in a hub has their own app, so the rest of the app works, and you can write with any other kinwriter meanwhile.
- The hub view marks them `orienting`.
- The sidebar says "orienting" beside their name.
- Their card says "orienting" under their name.

## At the end

When their part is done, the orientation waits for you, on the `choices` step. The panel in #practice shows the form, and their page says your choices are waiting. Your choices:
- **Their character,** and anything else made in the orientation: keep (the default) or discard.
- **The practice scene:** discard it (the default), or keep it as a starter. Kept, it's a real story channel with their character in it, and the canned partner is your notebook entry, to play as she is or swap for your own, picking up from their last line. Discarded, the partner goes with it.
- **Chattiness from now on,** starting at their stated preference.

Their notes save either way, and anything discarded goes in their intervention log. Their saved questions are posted to OOC, then every channel opens.

## API and data

- `POST /api/orientation/choices` now works for both versions. On their own, `scene` defaults to `discard`, and there's no `conversation` choice.
- `GET /api/orientation` adds `bingo: { tools, used, secrets }` on their own, and `choices.version` and `choices.questions`.
- The session keeps `partner`, `canned` and `questions`.
- New tool: `save_questions_for_user`, offered only in the questionnaire.
- The hub's kinwriter summaries have `orienting`.

**Tests:**
- The version on their own, start to finish: the practice scene with its two canned posts, the lessons on it, the questionnaire, bingo, waiting at your choices, keeping the scene as a starter with the partner as your character, and their questions in OOC.
- By default the scene goes, with its partner, and the log says so.
- In a hub, only the orienting kinwriter is marked, and another kinwriter answers as usual.
