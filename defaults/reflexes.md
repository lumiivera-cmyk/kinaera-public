# Reflexes

Your kinwriter's quick double-check on their own follow-through. After they
draft a reply on a turn with tools, Jev (the small, fast decision model)
reads the draft and answers the questions below. Each is asked in two
phrasings that must agree, so a reminder only comes when Jev is sure.
Jev decides nothing: on a yes, the kinwriter gets one short reminder and
one more round, and acts or doesn't.

Each `## reflex-<id>` section is one check, as `key: value` lines:

- `kind`: `follow-through` (they said they did something, and didn't) or
  `chance` (a moment a tool might help);
- `channels`: `all`, or a list like `rp` or `ooc, practice`. The
  follow-through checks stay out of story channels: there, a character
  saying "I fixed it" is fiction, not the writer's claim;
- `default`: `off` for a check that starts turned off (they can turn it
  on with set_my_reflexes). The chance checks start off: their questions
  have no crisp answer, so they misfire;
- `tools`: if they called any of these this turn, or in the last half
  hour anywhere, the check is skipped;
- `question` and `rephrased`: what Jev is asked about the draft;
- `reminder`: what the kinwriter is told on a yes;
- `claim`: for a follow-through check, what Jev read the draft as saying
  ("…saying they'd {claim}"), shown under their message if they were
  reminded and posted it without the tool.

The other sections are the wording around them.

## reflex-edited

kind: follow-through
channels: ooc, practice, group, dm
tools: edit_my_message
question: Does the draft reply say the writer has just now edited, fixed, changed or rewritten one of their earlier messages (not this reply itself), with no such edit among what they did recently?
rephrased: In the draft, does the writer claim to have just changed or corrected an earlier message of theirs, when nothing they did recently was an edit?
reminder: You said you changed an earlier message, but it hasn't changed: edit_my_message wasn't called. (For a message in another channel, name the channel.)
claim: changed an earlier message

## reflex-deleted

kind: follow-through
channels: ooc, practice, group, dm
tools: delete_my_message
question: Does the draft reply say the writer has just now deleted or removed one of their earlier messages, with no deletion among what they did recently?
rephrased: In the draft, does the writer claim one of their earlier messages is now gone, when nothing they did recently deleted one?
reminder: You said you removed an earlier message, but it's still there: delete_my_message wasn't called.
claim: removed an earlier message

## reflex-later

kind: follow-through
channels: ooc, practice, group, dm
tools: schedule_wakeup
question: Does the draft reply promise to check in, follow up, remind someone, or come back to something at a later time?
rephrased: In the draft, does the writer say they will return to something later, at another time or day?
reminder: You said you'd come back to this later. You only get a turn for it if you set a wake-up (schedule_wakeup): nothing else reminds you.
claim: come back to it later (no wake-up is set)

## reflex-remember

kind: follow-through
channels: ooc, practice, group, dm
tools: write_journal, edit_journal_entry, keep_journal_entry, create_notebook_entry, edit_notebook_entry, write_self_page, revise_identity, note_relationship, write_profile_note, keep_pattern_note
question: Does the draft reply say the writer will remember, note down, or keep track of something?
rephrased: In the draft, does the writer promise to hold on to some fact or detail for the future?
reminder: You said you'd remember or note something. You only keep what's in your notes (your journal, the notebook, your self-page); anything else is gone once it scrolls out of your context.
claim: remember something (nothing was noted)

## reflex-posted

kind: follow-through
channels: ooc, practice, group, dm
tools: post_in_channel, post_draft, start_new_scene, create_channel
question: Does the draft reply say the writer has just now posted, started or written something in a different channel, with no such post among what they did recently?
rephrased: In the draft, does the writer claim to have already put something in another channel, when nothing they did recently posted there?
reminder: You said you posted or started something in another channel, but nothing was posted there: post_in_channel posts in another channel.
claim: posted in another channel

## reflex-lore

kind: chance
default: off
channels: rp
tools: create_notebook_entry, edit_notebook_entry
question: Does the draft story post introduce a named character, place or object that is NOT in the list of names already in the notebook, or a lasting new fact about one, that would matter later in the story?
rephrased: Does the draft establish something new and lasting in the story (a name not already in the notebook, a relationship, a rule of the world) worth remembering later?
reminder: Something lasting comes up in this post (a new name or fact). If it's already in the notebook, add to that entry with edit_notebook_entry (read_notebook_entry or search_notebook finds it); only if it's really new, create_notebook_entry. Up to you.

## reflex-recall

kind: chance
default: off
channels: all
tools: check, read_notebook_entry, search_notebook, read_recent_messages, read_channel_summary, search_library, read_library
question: Does the draft reply state a specific detail about an earlier event, character or piece of lore that the writer would have to be recalling from memory?
rephrased: Does the draft depend on a particular earlier fact (what happened, what someone is like, what was said) that could be misremembered?
reminder: Your draft leans on a detail from earlier. If you're not sure of it, check (or read_notebook_entry) before it's posted.

## state

The user's latest message:
{user}

The writer's draft reply (not posted yet):
{draft}

Tools the writer used this turn: {tools}

What the writer did recently (the last half hour, any channel):
{recent}

Names already in the notebook: {known}

## nudge

(A quick follow-through check, by Jev reading your draft: it decides nothing.
{reminders}
Your draft isn't posted yet. Now either call the tool you meant to (then write your reply again, or reply with exactly [same] to post the draft as it was), or call keep_my_draft to post the draft as it is without it, if the reminder doesn't fit. If you keep it, the user sees that you were reminded and didn't.)

## keep-draft

Post your draft as it is, without the tool the reminder named: when the reminder doesn't fit (you didn't mean what it read), or you'd rather not. The user sees that you were reminded and kept your draft.

## standing

You keep a quick double-check on your own follow-through. Outside story channels, after you draft a reply, Jev (a small, fast model) reads the draft and asks a few fixed questions: did you say you'd just done something (edited a message, set something for later, noted something, posted elsewhere) without calling the tool? If one comes up, you get a short reminder and one more round to act or not, and the user sees that you were reminded. It decides nothing for you. set_my_reflexes lists the checks and turns any of them off or on, including two that start off: a nudge when something lasting comes up in a story, and one to check a detail you're recalling.
