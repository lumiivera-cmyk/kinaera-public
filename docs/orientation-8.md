# Orientation stage 8: the interview

A new step in the version together, after the closer: **the interview**. Two writers meet before they start working together. It isn't "who are you, really", and it isn't a character sheet. Your kinwriter answers as the writer they are, and that writer is the one who writes with you from then on.

## How it goes

You take turns.
- **You ask first.** The step has no turn of its own (`step-interview-after: message`): their part sits in their prompt, and they answer when you write in #practice.
- **They answer, then ask you one question.** Their prompt lists their cards, but they're free to ask anything. What they ask is theirs to choose, since it's how they get to know you.
- **You end it,** with Next. After a handful of messages each way (`wrap-up-after`, 5), the card says you can wrap up whenever you like.

## Question cards

The cards are in `defaults/interview.md`:
- `for-kinwriter`: the questions you can ask them;
- `for-user`: the questions they can ask you.

Your card shows three of yours at a time, shuffled. "More questions" deals three more, fresh ones first. Tapping a card puts it in the message box, for you to send as it is or change. Writing your own question is better.

The file also states the rule for new cards: questions are about writing and craft, never your life. At least one card draws out a real difference ("Something you'd push back on if I asked for it?").

## Keeping something to yourself

Any question can be declined, on either side, and both cards say so up front.
- **You:** "Keep something to myself" posts "(I'm keeping something to myself.)" in #practice. That's all they see. If you add a note, it's kept for you in the notebook as "Kept to myself", hidden from them.
- **Them:** `keep_to_myself`, a tool offered only during the interview, writes in their journal. The feed and the tool log show only "is keeping something to themselves".

## API and data

- `POST /api/orientation/keep` with `{ note? }`. It's refused outside the interview.
- `GET /api/orientation` adds `interview: { cards, yours, theirs, wrapUp }` on that step. `yours` and `theirs` count the messages each of you has written in #practice since the step began.
- The session keeps `stepAt`, when the current step began.
- A step can now have `after: message`: no turn of its own.
- In their part, `{cards}` becomes their questions for you.

**Tests:** the version together goes on from the closer to the interview. They check that:
- no turn runs when the interview begins;
- your cards are there;
- their reply carries the interview and their cards;
- their `keep_to_myself` reaches the journal, and the feed shows only that it happened;
- your keep posts the line and hides your note from them;
- the counts and the wrap-up nudge work;
- you end it with Next.
