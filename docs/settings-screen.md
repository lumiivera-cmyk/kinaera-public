# The Settings screen

Settings is one screen: a list of sections down the side, and the open section beside it. On a phone the list fills the screen; tap a section to open it, and the back arrow returns to the list. The gear opens it (on a wide screen, on the section you had open last).

Every setting lives in exactly one section. The sections are grouped by who they're for, and each says so under its title.

| Group | Section | What's in it |
|---|---|---|
| Every kinwriter | Models | "Just for", what writes roleplay and OOC, who writes what, profiles and roulettes |
| | Memory | "Just for", recent messages, summaries, how often, and what writes them |
| | Reaching out | "Just for", chattiness, away after, cooldown, quiet hours, after story posts, heartbeat, heartbeat check, recent wake-ups, Beat now |
| | Jev | Jev's model, how sure Jev has to be, the fallback, Test Jev, check log |
| | Prompts | every prompt's wording, and the dry run |
| | Rules | hard limits |
| | Look | "Just for", theme, sliders, background picture and fade; glass effects and fold quiet turns (this device only) |
| The open kinwriter | Profile | name, pronouns, avatar, colour, self-notes (to read, if shared), archive, own server, delete |
| | How they write | literary, casual and OOC prompts, match my pace |
| | How they behave | texting in OOC (pause, typing speed), scripts |
| This server | Kinwriters and groups | the server's name, its kinwriters, archived kinwriters, group channels and DMs, delete the server |
| App | Custom emojis | add and delete |
| | Labs | Kinwriters together (untested) |
| | API key and setup | your `.env` file (see the README) |
| | Developer | the developer panel (only with `DEVELOPER_PANEL=1`) |

Not in Settings, because they belong to something else: a channel's own settings (from its header), the kinwriter's page (tap their card), the notebook, the library and the inbox.

## Saving

Changes save as you make them: a tick or a choice at once, a box when you leave it (or press Enter). "✓ Saved" shows in the header for a moment. A section is saved whole, so a quick second change waits for the first.

If a value can't be saved (an empty "Recent messages", say), the reason shows at the bottom of the section, kept in view, naming the box by its label, and the boxes go back to what was last saved. That way one bad value never stops later changes from saving. The message goes when you open another section.

Two things keep a Save button. API key and setup, because a half-typed port or address there could stop the app from starting. And each piece of prompt wording in Prompts, because a change there reaches every kinwriter; wording you've changed but not saved stays put if you visit another section and come back. Above each box, a line in small print says where that wording is used; it comes from a `<!-- ... -->` note right under the section's heading in `defaults/`, which is never sent to a model.

The "Just for" boxes are in Models, Memory, Reaching out and Look, and work the same in each (see [shared settings](shared-settings.md)). What writes summaries, the heartbeat check and Jev stay in Memory, Reaching out and Jev, so each follows that section's "Just for"; Models' "Who writes what" lists them all.

## The old ways in still work

The palette button opens Look; tapping the server's name (or its icon in the rail) opens Kinwriters and groups; "Custom emojis…" in the reaction picker opens Custom emojis; **Their settings…** on a kinwriter's page opens Profile; a channel's Preview prompt → Dry run opens Prompts on the Dry run tab.

## In the code

`public/js/settings-hub.js` is the screen: the list, switching sections, the phone's back arrow, and "Saved". Each section is a `.settings-panel` in `public/index.html`, and the module that owns it fills it: `settings.js` (Every kinwriter), `kinwriter-page.js` (Profile, How they write, How they behave, Kinwriters and groups), `themes.js` (Look), `prompts.js`, `reactions.js` (Custom emojis), `server-setup.js`. They use `whenSettingsOpen` to fill a form that's saved whole, and `whenSectionShown` for anything slow to load. Nothing about the settings themselves changed: no migration.
