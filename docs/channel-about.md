# What a channel is for

Your kinwriter was having trouble keeping #off-topic apart from #ooc. In their prompt, every out-of-character channel looked the same: "another out-of-character chat", with the same OOC instructions, the same story summaries, and nothing to say what #off-topic was for except its name.

## A line on each channel

Each channel can say what it's for, in one line, like "anything but the stories: music, food, our days" (300 characters at most).

- **You set it** in Channel settings, under "What it's for". It shows in the channel's header. For a story channel, it comes before who plays whom.
- **Your kinwriter can set it too:** with `describe_channel`, or `about` when they make a channel with `create_channel`. Like renaming, it's direct, and it shows in the tool log.
- **In that channel,** their prompt opens "This channel" with "What this channel is for: …" and a line asking them to keep to it. The wording is `channel-about` in `defaults/turns.md`.
- **In every other channel,** the channel list shows it beside the name: `#off-topic: another out-of-character chat (for: anything but the stories…)`.

## Bare names bring in only storylines

In OOC, a channel that came up in the last few messages gets its summary added to the prompt. A `#tag` still does this for any channel. A channel's bare name (the word "story") now only counts for story channels. So saying "ooc" in #off-topic no longer pulls #ooc's talk in. To bring another OOC chat in, `#tag` it.

## Data

- Migration 11 adds `channels.about` (text, "" for existing channels).
- `PATCH /api/channels/:id` takes `about`. The text is trimmed and its spaces collapsed, and over 300 characters is refused.

**Tests** (test/rewrites.test.ts) cover:
- the line in the channel's own prompt, and beside its name in another channel's list;
- refusing an over-long line;
- `describe_channel`;
- another OOC chat coming in only when `#tagged`, while a storyline still comes in by its bare name.
