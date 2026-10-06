# The orientation redesign

Kinaera's orientation is a live mode you and your kinwriter go through together (or that they go through on their own). It was built in ten stages, each with a doc in `docs/` named `orientation-<n>.md`.

Decisions made along the way:

- **Stage 1 (the rename):** everything you see says "kinwriter": the app, the prompts, the docs, file and function names. Values already saved in your data stay as they were, as internal labels. These are the `"friend"` author and owner values, the settings keys (`friendName`, `friendPrompt`, `friendAvatar`, `friendColor`), the fields in `hub.json`, the `friends/` folder, and the API routes. So nothing in an existing data folder needs migrating.
- **Stage 2 (kept apart):** the switch is hub-wide, for every kinwriter on every server, rather than per server. Group channels and DMs made before it are kept, hidden, while it's off.
- **Reflexes (between stages 4 and 5, at your request):** kinwriters use Jev to remember to call their tools ([docs/reflexes.md](docs/reflexes.md)). Jev reads each draft and reminds them, and they decide. This changes the plan in three places:
  - The catalog of everything they can do lists `set_my_reflexes`.
  - The solo-instruments lesson (stage 7) teaches their reflexes alongside `check`, `ask` and `consult`: they look at their checks, turn off any they don't want, and write a map entry for it.
  - Tool bingo (stage 10) counts only tools they call. A reflex reminder shows in the feed, but doesn't fill a square.
- **Stage 4 to 5 (steps):** orientation runs as steps listed in `defaults/orientation.md`. Each later stage adds its steps there, in the guide's order: opener, characters, starter scene, ladder lessons, closer, interview, write-up, choices.
- **Stage 7 (ladder lessons):**
  - A lesson you try first waits for you: their part runs when you tap "Hand it to {name}" (`step-<id>-after: you`).
  - The lessons go in a fixed order (editing, profiles, library, linking, instruments) rather than as they come up in the scene: the step list is plain wording, and the order matches how each one uses the scene.
  - The Night of the Living Dead text is fetched by `bun run fetch-example`, since this build's container couldn't reach Wikisource. Until it's committed, the library lesson says so and works with whatever is in the library.
  - Their first draft of tastes moved into the instruments lesson until the write-up (stage 9).
- **Stage 8 (the interview):**
  - Your "Keep something to myself" posts a line in #practice. Its optional note goes in your notebook, hidden from your kinwriter, so you can still read it. Theirs is a tool, `keep_to_myself`, offered only during the interview, that writes in their journal.
  - The wrap-up nudge comes once you've each written 5 messages (`wrap-up-after` in `defaults/interview.md`).
- **Stage 9 (the write-up and choices):**
  - The starter scene is a third choice of its own (keep or delete), next to the characters and the conversation.
  - "Set aside" takes the orientation's messages in #practice out of the conversation, the way a deletion does.
  - Chattiness is one of the choices too, starting at their preference, so it's set by you, visibly.
  - The "from orientation" mark is kept as time windows rather than a field on every record. It shows on journal entries in their prompt and in identity changelog notes.
- **Hard limits, after use:** the closer no longer asks for them. Being pushed to set them that early felt wrong. The setting is still there, in Settings → Advanced, marked optional, and still goes in every prompt when it's filled in.
- **Stage 10 (the version on their own):**
  - The canned partner's posts are stored as yours (author "user"), since the partner becomes your character if you keep the scene. Their part says plainly that she's canned.
  - The version on their own no longer ends by itself: it waits for your choices, so the practice scene isn't left lying around. The lockout stays until you choose.
  - Linking on their own posts an ending in the practice scene, never in your channels.
