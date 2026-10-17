# Shared settings

The Settings menu, and the connection profiles and roulettes, are the same for every kinwriter on every
server. Change them while looking at any kinwriter and everyone has the change.

## Just for one kinwriter

Three sections can be set for one kinwriter alone, with the "Just for …" box at the top of each:

- **Models**: which profile or roulette writes roleplay and OOC.
- **Memory**: recent messages, summaries, and who writes them.
- **Reaching out**: chattiness, quiet hours, asides and the heartbeat.

While a section is ticked, changes to it stay with that kinwriter, and changes made while looking at someone
else pass them by. Unticking it gives them everyone's values again. Jev and hard limits are always shared.

A kinwriter's own sections are kept in their database (`app_state`, key `settings.own`), so they travel with
an exported kinwriter. Choosing a chattiness at the end of an orientation makes reaching out that kinwriter's
own, since it was chosen for them.

What stays each kinwriter's own, as before: who they are (name, prompts, avatar, colour, pronouns), and the
options on their own page (texting, match my pace, scripts). The look (theme) is unchanged too.

## How it works

Each kinwriter is still a whole app with its own database (src/hub.ts), so each keeps a copy. The hub keeps
the copies the same (src/universal.ts):

- `PUT /api/settings` on any kinwriter: the shared settings it changed (outside that kinwriter's own sections)
  are saved in `hub.json` (`settings`) and sent to every other kinwriter, the same way Save sends them (so the
  heartbeat and summaries catch up), except to anyone who has that section as their own.
- Making, changing or deleting a profile or roulette on any kinwriter: every other kinwriter's copy is made the
  same, in place (`syncProfiles`): notes a kinwriter keeps on a profile stay, and anything assigned to a
  deleted one goes back to the default.
- `PUT /api/hub/kinwriters/:id/own` with `{ group, own }`: a section just for that kinwriter, or shared again.

## From before settings were shared

The first time Kinaera starts with this, it makes one set from what each kinwriter had (`adopt` in
src/hub.ts), changing nothing about how anyone writes:

- The first server's first kinwriter's settings become the shared ones.
- Any other kinwriter whose models, memory or reaching out differ keeps theirs, as their own section.
- Hard limits are put together: every kinwriter has all of them. None is dropped.
- Profiles and roulettes are put together. One only some kinwriter had is added for everyone. One that had
  been changed for just one kinwriter (same profile, different settings) is kept as a new profile named with
  theirs, like "DeepSeek (Wren)", and they keep writing with it.
- Jev's settings: the first kinwriter's.

An imported kinwriter, or one restored from the archive, is brought in the same way.
