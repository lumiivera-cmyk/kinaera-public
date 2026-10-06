# Orientation stage 2: kinwriters kept apart

Group features are built but untested, so they're now behind one switch, **off by default**: Settings → Advanced → **Kinwriters together (untested)**. It applies to every kinwriter on every server, and it saves as soon as you change it.

**Off (the default):**

- **No group channels or DMs.** Ones already made are kept, out of sight: they're left out of the channel list, every prompt, every tool and every screen. Opening one by its address gives "403". New ones can't be made, and the group part of server settings is hidden.
- **No `message_kinwriter`, and no `note_relationship`** about other kinwriters.
- **They don't appear to each other.** The "Kinwriters here" part of the prompt goes, and nothing names the others.
- **Orientation doesn't mention any of it**, since its catalog lists only the tools a kinwriter has.

You can still make several kinwriters, on one server or many. Dice, replies and status stay on, since they work with one kinwriter.

**On:** everything is as it was before this stage, including group channels and DMs made earlier.

The note a kinwriter will keep on *you* (stage 9) reuses the relationship notes. So this stage blocks notes on other kinwriters specifically, by having no other kinwriters in view, rather than switching off the relationship notes.

## How it works

- `hub.json` keeps `together` (missing means off).
- `PATCH /api/hub/options` with `{ together }` changes it, and `GET /api/hub` reports it.
- While it's off:
  - each kinwriter's `peers()` is empty;
  - `Store.hideShared()` keeps group channels and DMs out of `listChannels()`;
  - the hub refuses its group routes;
  - the channel guard answers 403 for a group channel or DM.

**Tests:** `test/groups.test.ts` turns the switch on for the group tests. A new test covers the off state: the tools and the prompt, the hidden channel, refusing a new group, and everything coming back when it's turned on again.
