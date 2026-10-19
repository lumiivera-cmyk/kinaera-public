# Scratchpads

Wording for a story channel's scratchpads (src/scratchpads.ts): the shared
one, and your kinwriter's private one, as their prompt carries them. One
`## name` section each; `{placeholders}` are filled in by Kinaera.

## intro

<!-- Opens the Scratchpad section of the kinwriter's prompt in a story
channel, shown on turns with tools or whenever either pad has something in it.
-->

Loose notes for this storyline, kept apart from the notebook: details, where everyone is, secrets, threads to pick up, notes on a character or a place. Nothing here is lore until it's in the notebook. The user also keeps a private one here, which you never see.

## intro-tools

<!-- Added to the Scratchpad section of the kinwriter's prompt, after the
opening, only on turns when they have tools. -->

Jot things down as they come up, with write_scratchpad (shared) or write_private_scratchpad (yours alone), and tidy them when they get long. When a note has settled into something lasting, save it to the notebook with scratchpad_to_notebook (as a new entry, or added to one).

## shared

<!-- Heads the shared pad in the Scratchpad section of the kinwriter's prompt.
{changed} is filled with when it was last changed, or that it never was. -->

Shared with the user ({changed}):

## private

<!-- Heads the kinwriter's own private pad in the Scratchpad section of their
prompt. {changed} is filled with when it was last changed, or that it never
was. -->

Your private scratchpad, only you see it ({changed}):

## empty

<!-- Shown under a pad's heading in the kinwriter's prompt when that pad has
nothing in it. -->

(empty)

## never

<!-- Fills {changed} in a pad's heading in the kinwriter's prompt when nobody
has written in that pad yet. -->

never written

## changed

<!-- Fills {changed} in a pad's heading in the kinwriter's prompt. {who} is
you or the kinwriter; {when} is how long ago. -->

last changed by {who} {when}

## introduction

<!-- Added once to the kinwriter's notices, on their first turn with tools
after scratchpads arrived, to tell them about the feature. -->

New: each story channel now has scratchpads. One is shared with the user, one is yours alone, and the user has one of their own. They're for loose notes that aren't lore: details, where everyone is, secrets, ideas. They show in your prompt in that channel, under "Scratchpad". You write them with write_scratchpad and write_private_scratchpad, read another channel's with read_scratchpad, and save a settled note to the notebook with scratchpad_to_notebook. You might add them to your tool map.
