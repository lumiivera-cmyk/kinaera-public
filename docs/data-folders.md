# Data folders: start fresh, old folders, export and import

`bun run fresh` sets every kinwriter's memory aside and starts over. The data folder becomes `data-old-<date>` next to it, and nothing is deleted. The developer panel can now do the same from inside the app, and work with those old folders.

**For now it's only in the developer panel.** Start the app with `DEVELOPER_PANEL=1` in `.env`. The panel is at the bottom of a kinwriter's health view, and the section is **Data folders**. Without that setting, none of these routes exist.

## What's there

- **Start fresh.** It does what `bun run fresh` does, without stopping the server:
  - every kinwriter is closed;
  - the data folder is set aside as an old folder;
  - the app reloads on **Meet your new kinwriter**.

  Your connection profiles, roulettes, preferences, themes and prompt edits carry over, and your API key is in `.env`, untouched. You're asked twice before it happens. The command still works, with the server stopped. Both share `startFresh` in `src/datafolders.ts`.
- **Now:** the kinwriters you have, each with **Export**.
- **Old folders,** newest first. Each kinwriter shows their channels, messages and when they last wrote. Three actions:
  - **Open** reads their channels and messages, read-only, a hundred at a time, with "Earlier messages" for more. Their journal, drafts and DMs aren't shown: those are theirs.
  - **Export** saves them as one file.
  - **Bring back** makes them a new kinwriter, on a server of their own. Their old folder stays as it is.
- **Import a kinwriter** loads an exported file. They come in as a new kinwriter, on a server of their own.

## Old folders are never changed

Even opening a database read-only leaves SQLite's side files (`-shm`, `-wal`) next to it. So everything read from an old folder is read from a copy of its files in a temporary folder:
- the list;
- browsing, which also upgrades the copy to the current layout, so any old folder can be read;
- exporting and bringing back.

The current kinwriters are open in the app already, so they're read directly, and exported from a snapshot of their open database.

`Store.close()` now folds the database's write-ahead log back into the main file first. Bun can keep a closed connection around until it's cleaned up, so without this a folder set aside could be missing its newest writes.

## The exported file

`<name>.kinwriter.json` is JSON:
- `format` and `version` (`"kinaera-kinwriter"`, 1);
- `name` and `exportedAt`;
- `database`: a clean snapshot of their `kinaera.db`, in base64;
- `emojis`: their custom emoji images, by file name, in base64.

Importing checks the file before anything is written:
- the format, and a version no newer than this Kinaera's;
- a real SQLite database, with a kinwriter's tables;
- safe emoji file names.

Opening it upgrades the database to the current layout, so files from older versions work.

**What doesn't come along:** group channels and DMs with other kinwriters belonged to the old hub. A kinwriter brought back keeps their copies, out of sight, the same way they are when kinwriters are kept apart.

## Routes (with `DEVELOPER_PANEL=1`)

| Route | What it does |
| --- | --- |
| `GET /api/hub/dev/folders` | The current folder and the old ones, with their kinwriters |
| `POST /api/hub/dev/fresh` | Start fresh |
| `POST /api/hub/dev/import` | Import an exported file (its JSON as the body) |
| `GET /api/hub/dev/folders/:folder/kinwriters/:id` | An old kinwriter's channels (`:folder` is `current` or an old folder's name) |
| `GET …/kinwriters/:id/channels/:channelId?before=` | A channel's messages, read-only |
| `GET …/kinwriters/:id/export` | Download them as a file |
| `POST …/kinwriters/:id/import` | Bring them back from an old folder |

Only the folders the list shows, and only kinwriters inside them, can be named.

**Tests:** `test/datafolders.test.ts`.
