# Orientation stage 4: a live mode you pick

Orientation is no longer a background wake-up behind an invitation, a queue, a one-minute timer and the cooldown. It's a mode you pick, and it starts at once.

## Picking one

**Neither version ever runs by itself.** Something starts only when you pick it:

- **A new kinwriter:** when you open one who has never had an orientation, the app offers it.
  - **Together** is the default.
  - **On their own** is the second choice.
  - **Skip** is under **Advanced**, hard to hit by accident. Skip means skip: nothing runs, and their page then says they haven't had an orientation yet, with a button for each version.
  - **Later** just closes the offer. It comes back the next time you open them.
- **They ask** (`start_orientation`, with an optional note): it becomes a request on their page. They're told it's waiting. You pick a version, or **Not now**, which goes in the intervention log so they know. Nothing starts until you answer, and they can't ask again while a request is waiting.
- **A new profile joins a roulette:** unchanged. They're told, and they can ask.
- **Another one later:** from their page.

A kinwriter who had an orientation the old way counts as having had one.

## Once picked

It starts straight away, in their **#practice** channel. Cooldown, quiet hours and the `Rhythms` timer don't apply, and its turns run back to back.

**Together:**
- Their first turn starts at once, with the guide (`orientation-together` in `defaults/orientation.md`): the user is right here, watching.
- You can write in #practice for as long as it lasts. Each reply carries the guide too, under "Your orientation", with the extra rounds an orientation gets.
- **Finish** ends it.

**On their own:**
- Their turns run back to back. A message from the first can be edited in the second.
- It ends by itself.

**The live feed.** A panel at the top of #practice lists every tool they use, as it happens, in readable words: "wrote in their journal", "asked the user…". A private action only shows that it happened, never what was written, since it comes from the tool log, which keeps that out already.

**While it runs, their other channels wait.** You can't write or ask for turns there; the composer says why, and the server answers 409. No wake-up, heartbeat or aside starts either. Other kinwriters aren't affected.

## What was retired

The invitation, its notices and their settlement, the queued orientation and its "held by" status, the second-part queue and orientation's place in `Rhythms` and the wake-up rules are all gone. The weekly look back is unchanged.

## API

- `GET /api/orientation`: `{ orientation: { status, session, request, lastDone, writing, practiceId, last }, feed }`. `?after=<id>` returns only the feed since that tool call.
- `POST /api/orientation/start` with `{ version: "full" | "returning" }`.
- `POST /api/orientation/finish`, `POST /api/orientation/skip` and `POST /api/orientation/decline`.
- `GET /api/state` and the kinwriter page include `orientation`.

**Tests** (`test/self.test.ts`, "orientation"):
- nothing runs by itself;
- on their own: starts at once, turns back to back, ends by itself;
- together: writing in #practice, the feed (private actions without their content), other channels waiting, and Finish;
- the guide;
- room for many rounds;
- a request, and Not now;
- Skip.
