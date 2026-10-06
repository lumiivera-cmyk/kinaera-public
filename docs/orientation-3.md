# Orientation stage 3: the health view and the developer panel

These are for whoever is building Kinaera, while it's being tested. They come early so the rest of the orientation work can be checked with them.

## Health

**Where:** on a kinwriter's page (tap them in the sidebar), under **Health**. It's always there.

**What it shows:** how their tools and notes are doing, by *shape*: counts, tool names, lengths and limits. It never shows what was written. It's built on the tool log, which keeps private tools' arguments as "(private)" anyway. Identical arguments are compared, never shown. It looks for:

- **Tools that keep failing:** at least 3 failures in a week, and more failures than successes.
- **The very same call failing again and again**, like a delete that never goes through: 3 or more times this week with identical arguments.
- **The same note rewritten over and over:** a rewriting tool, such as `write_self_page`, `revise_identity`, `write_profile_note` or `save_draft`, used 5 or more times in a day.
- **Sections stuck at their length limit** (90% full or more):
  - identity and tastes;
  - the self-page's sections and its short version;
  - the longest journal entry and the longest draft;
  - wake-ups scheduled.
- **A journal with no kept entries:** 8 or more entries and none kept, so all but the newest fade.
- **Wake-ups that failed** this week.

Under the findings are each tool's calls this week (ok and failed), and how full each limited thing is. The thresholds are at the top of `src/health.ts`.

## The developer panel

One organised view of everything private about a kinwriter, to check the note-taking works:
- their journal;
- their drafts;
- their notes on others and on profiles;
- notebook entries hidden from you;
- DMs you chose not to see;
- their orientation invite note.

**It's hidden and hard to reach.** It only exists when `.env` has `DEVELOPER_PANEL=1`. Even then, it's a link at the bottom of Health. Without that setting, `GET /api/developer` answers "not found", and the link isn't there.

**It's disclosed to the kinwriter.** Their prompt says plainly (`developer` in `defaults/standing.md`, part of "Good to know" on turns with tools) that:
- while Kinaera is being built, its developer may occasionally open their private notes to check the tools work;
- openings aren't logged or announced, the way a doctor doesn't tell you each time they open your chart;
- the developer and the user may be the same person.

That keeps "private" in their prompt true. This is a deliberate exception to "your power is visible to them", so opening the panel isn't logged anywhere, and its content never goes to the server's log.

## API

- `GET /api/health`: `{ findings, tools, limits }`, shape only.
- `GET /api/developer`: the panel's content. It's 404 without `DEVELOPER_PANEL=1`. `GET /api/state` says `developerPanel: true|false`.

**Tests:** `test/health.test.ts` covers each finding, that a report never contains the words it's about, that the panel doesn't exist without the setting, and the disclosure in the prompt.
