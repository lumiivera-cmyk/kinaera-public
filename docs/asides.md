# After a story post: a moment in OOC

When your kinwriter posts in a story, they get a short turn in your OOC channel afterwards, as themselves. They can say something to you out of character, like a reaction, a question or an idea for where the story could go. More often they'll let the story speak for itself. Nobody else decides for them: no Jev, no grading. It's their own turn, with doing nothing as the normal choice.

## When it happens

After your kinwriter posts in a roleplay channel in answer to you. That covers a reply to your post, **Kinwriter's turn**, and a regeneration.

It doesn't happen after:
- their posts in OOC, group channels, DMs or the practice channel;
- a story post they made on a turn of their own, such as a wake-up they scheduled in #story.

The same plain rules as every wake-up still apply (`src/wakeups.ts`):
- **Chattiness** off turns it off, along with everything else.
- **Quiet hours.**
- **Never a third time without you writing.** Your own story posts count as writing, so while you're playing, this rarely stops it.
- **Its own limit**, Settings → Your kinwriter reaching out → **After their story posts**: after every story post (no limit), at most every 5, 15 or 30 minutes (the default), every hour, every 3 hours, or off. This is apart from the general cooldown, so a long cooldown for coming back to the app doesn't hold asides back. An aside does count toward the general cooldown, though, so a heartbeat right after one waits.

It isn't blocked for being "mid-conversation", as opening the app is: you're always mid-story when it happens.

With no limit, one aside still never overlaps another (only one wake-up runs at a time), and "never a third time without you writing" still holds. Two unanswered messages in OOC, and the next waits until you write again, which in a story you do every post.

## What they see

Their usual OOC prompt, with **Why you're up** saying:
- that they just posted in #story;
- that this is a moment to say something as themselves if they want to;
- that usually there's nothing to add.

Under that are the story's three newest posts (each cut at 1,200 characters), so they know what they'd be talking about. The wording is `why-aside` in `defaults/turns.md`, editable in **Settings → Prompts**. **Dry run → After a story post** shows the whole prompt.

If they write, it's an ordinary OOC message: it notifies you like any wake-up, and it's in **Recent wake-ups** as "After a story post". If they do nothing, that's logged too ("didn't write"), and it costs one request.

## Settings and API

`asideMinutes` in the settings: -1 to 1440, where 0 is after every story post and -1 is off. The default is 30. The wake reason is `aside`.
