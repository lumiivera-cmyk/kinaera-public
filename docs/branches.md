# Branches

The conversation in a channel is a tree, the way NovelAI keeps one. Nothing
is lost when you go back.

## What you can do

- **Go back here** (on any message but the last): everything after it is set
  aside as a branch. Write something new, or let your kinwriter take a turn.
- **⑂ 2** next to a message's time: there's another way the conversation went
  on from it. Tap to see what's there now and each branch, and go to one.
  What's there now becomes a branch in turn.
- **Regenerate** on an earlier reply: what came after it becomes a branch,
  then the reply is regenerated. If generation fails, everything comes back.
- **Bring this one back** in a regenerated reply's history (↻): the earlier
  version returns, and the one that replaced it becomes an alternate.

Branches follow the message they started from. When that message leaves the
chat (it's regenerated, or it's in a branch you left), its branches go with it
and come back with it, so swapping a reply back also brings back what you
wrote after it. Deleting the message moves its branches to the message
before it.

Not in group channels or DMs (the others have already seen it all), not
while your kinwriter is writing, and not during an orientation.

## Your kinwriter

They only see the branch you're on, in the chat and in every prompt.
Going back or switching branches is written in the intervention log when
their messages are involved, so they can read that it happened. What they did
with tools on another branch (notes, journal entries) stays done.

## How it's stored

No new tables. A branch's messages are marked in `messages.superseded_by`
with `branch:<fork message id>:<random>`, so they leave the chat exactly the
way a regenerated reply does, and come back when the mark is cleared. The
branches you can go to are the marks whose fork message is in the chat
(`Store.branches`). Regenerated replies are kept flat: every earlier version
points at the reply shown now, so `alternates` counts all of them.
