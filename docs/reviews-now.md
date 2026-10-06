# Suggestions are answered right away

When you suggest something for your kinwriter, they now answer it straight away, the way they reply to a comment. That covers:

- a rewrite;
- a change to a notebook entry;
- a change to their identity;
- a note for their self-page.

Before, a suggestion woke them "if the hard rules allowed". That meant no turn with chattiness off, and at most one review every 10 minutes. A suggestion could easily sit there until your next message.

## How it works now

- **No chattiness, quiet-hours or cooldown limits.** A review isn't them reaching out: it's an answer to something you just did.
- **Only when something's waiting.** If nothing is waiting for them by the time the turn would start, for example because they answered it in a reply to you, no turn runs.
- **If they're busy,** with another wake-up or already writing there, it tries again every 2 seconds until they're free, for up to 2 minutes (`requestReview` in `src/wakeups.ts`). Several suggestions in a row lead to one turn that sees them all, or a second one for whatever arrived after the first began.

The review happens in OOC, in the channel you talked in last, as before.

**Tests** (test/wakeups.test.ts) check that a review:
- runs with chattiness off and a long cooldown;
- runs again straight away;
- doesn't run with nothing waiting;
- waits for a busy kinwriter, then runs.
