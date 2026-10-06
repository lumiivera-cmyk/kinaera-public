# Orientation stage 5: steps, the opener, the closer, hard limits

An orientation is now a list of **steps**, written in `defaults/orientation.md`, so the wording can change without touching code and the dry run can show it.

## Steps

- `steps-full` and `steps-returning` list the steps of each version, one id per line, in order.
- Each step is a set of sections:
  - `step-<id>-title`: its name.
  - `step-<id>-card`: **your card.** Plain words in the app, with no model call, so it's instant and free. `{name}` becomes your kinwriter's name.
  - `step-<id>-kinwriter`: **their part.** A turn they take when the step begins, carried in their prompt while the step lasts. `{catalog}` becomes everything they can do (only the tools they have), and `{suggestions}` a few things to try.
  - `step-<id>-followup`: a second turn straight after, if their first wrote a message (to try editing it).
  - `step-<id>-spotlights`: a tour of the real screen, one `selector | words` line per part.
  - `step-<id>-table`: a Markdown table on your card.

**Together:**
- The panel at the top of #practice shows "Step n of m", the step's title and your card.
- **Next** moves on and starts their part of the new step. It waits while they're still writing.
- **Finish** comes on the last step.
- **End now** stops early.

**On their own:** their parts run back to back, step after step, and it ends by itself. Steps without a part for them are skipped.

Their prompt always says where they are ("step 2 of 3"), and how this orientation works: together with you, or on their own.

The steps so far are below. Later stages add theirs to the list, in the guide's order: characters, starter scene, ladder lessons, interview, write-up, choices.

## The opener: where things are

**Your card:** "Show me" gives a tour of the real screen, one part outlined at a time:
- the channels, a story channel and OOC;
- the notebook (with the library);
- your inbox;
- their page;
- Settings.

On a phone the sidebar opens for the parts in it, and closes again at the end. Parts that aren't on screen yet (no story channel, say) are skipped.

**Their part:** they say hello, in a line or two.

## Trying their tools

The catalog of everything they can do, with a few suggestions to try. Then:
- a first journal entry, a first draft of their tastes, and how they'd like feedback;
- a follow-up turn to try editing a message they wrote.

Ladder lessons replace and extend this step in stage 7.

## The closer: yours, theirs, shared

**Your card:**
- A table of what's yours, theirs and shared, from the guide.
- **Open the intervention log**: anything you did directly, like editing their message, is there.
- Your **hard limits**, written right there.

**Their part:** they read the intervention log (`read_interventions`) while you watch the feed, and say in their own words what they find. They also mention their own "never write", which is in their tastes. So "your power is visible to them" is something you watch happen.

## Hard limits

A new setting, `hardLimits`: what must never be written, in any channel, whatever a story asks.
- **Yours:** it's in Settings, under **Your hard limits**, and it's copied to new kinwriters like your other preferences.
- **In every prompt:** under "The user's hard limits", with the wording from `hard-limits` in `defaults/turns.md`.
- **Also in the closer**, where you can fill it in.

**Changed later:** the closer no longer asks for hard limits (neither your card nor their part mentions them). The setting moved to Settings → Advanced, marked optional. Being pushed to set them that early felt wrong.

## Also

- The turn button and the empty-channel hint use your kinwriter's name: "Wren's turn".
- [Reflexes](reflexes.md), added between stages 4 and 5, show in the orientation's live feed. `set_my_reflexes` is in the catalog.

## API

- `POST /api/orientation/next` moves to the next step; after the last, the orientation is over.
- `GET /api/orientation` includes `step`: `{ id, title, card, kinwriter, followup, spotlights, table, index, count }`.

**Tests:** the orientation tests run the version together through its steps, and the version on their own back to back. Hard limits are covered with the settings.
