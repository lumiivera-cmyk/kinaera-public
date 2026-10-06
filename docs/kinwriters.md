# Kinwriters and servers

You can have as many kinwriters as you like. **Each kinwriter is a different person with their own memory**, and each usually has **a server of their own**, like having a Discord server with each kinwriter. A server can also hold several kinwriters.

## Using them

- **The rail** on the far left has one button per server; tap one to go there. A dot means a kinwriter there has written something you haven't seen. **+** makes a new server with a new kinwriter.
- **A new kinwriter**: give them a name, an avatar (an emoji) and who they are, or press **🎲 Surprise me** to invent someone. They start fresh: their own notebook, channels (#story and #ooc) and memory. They get your connection profiles and roulettes, and your preferences: models, Jev, reaching out, the heartbeat, texting and the look. They don't get the other kinwriter's identity, prompts or anything they remember.
- **The kinwriter menu**: tap the kinwriter card at the bottom of the sidebar for their page ([stage 4](own-things.md)), then **Settings…**. It holds their name, avatar and colour, who they are (a change there is a suggestion they answer; Surprise me rerolls it), how they write in literary, casual and OOC channels, and texting. Their avatar and colour show on their messages, the kinwriter card and the rail.
- **Server settings**: tap the server's name at the top of the sidebar, or its button in the rail. You can rename it, see who's there, **add a kinwriter here**, or delete it.
- **Several kinwriters in one server**: the sidebar shows each kinwriter's channels under their name and avatar. Each channel belongs to one kinwriter: they're the one who writes there, and only they know what's in it. Opening another kinwriter's channel switches to them, and the kinwriter card, notebook and settings become theirs. From a kinwriter's menu, **Own server** moves them out into a server of their own.
- **Deleting** a kinwriter (their menu → Delete…, typing their name to confirm) or a server moves their files to `data/trash/`, not away for good. You can't delete your last kinwriter.
- Phone notifications open the right kinwriter's channel.

## Separate memory, by construction

Each kinwriter is a complete Kinaera of their own (`src/hub.ts`). They have their own database and folder, so their own:

- notebook, including their secrets, suggestions and pins;
- channels, categories, messages, comments, reactions and tool log;
- summaries;
- wake-ups, heartbeat, inbox, and the check and intervention logs;
- reference library and custom emojis;
- settings and prompts.

Nothing is shared between kinwriters except your own themes and the connection profiles you choose to copy when making one. So no kinwriter can ever see another's notebook, secrets or conversations: there's no code path between them to get it wrong. When two kinwriters share a server, only the sidebar puts them side by side, and each one's prompt only ever contains their own channels.

## How it works

The server runs a **hub** in front of one app per kinwriter:

| Request | Goes to |
| --- | --- |
| `/p/<friend>/api/...` and `/p/<friend>/emojis/...` | That kinwriter's app |
| `/api/hub/...` | The hub: servers and kinwriters |
| Anything else (the web app, themes, and `/api/...` from older pages) | The first kinwriter's app |

The page works on one kinwriter at a time. Its requests are prefixed with that kinwriter (`scoped` in `public/js/core.js`), and the address says whose channel is open: `#/p/<friend>/channel/<id>`. Switching kinwriters (another server in the rail, another kinwriter's channel, a notification) reloads the page as theirs. Every 15 seconds the page also asks the hub for every kinwriter's channels and newest messages, for the dots in the rail and the other kinwriters' sections.

### The data folder

```
data/
  hub.json          the servers and their friends
  kinaera.db        your first friend (where Kinaera always kept its data)
  emojis/           their custom emojis
  themes/           your own themes, shared by everyone
  friends/<id>/    each other friend: kinaera.db, emojis/
  trash/            deleted friends
```

Upgrading changes nothing: the existing database becomes the first kinwriter, in the first server. To back up, stop the server and copy the whole `data/` folder.

### The hub's API

- `GET /api/hub`: the servers. Each has its kinwriters, and each kinwriter comes with their name, avatar, colour, channels, categories, each channel's newest message, and where they're writing.
- `POST /api/hub/servers` with `name`, and optionally `prompt`, `avatar`, `color`, `serverName` and `copyFrom` (the kinwriter whose profiles and preferences to copy): a new server with a new kinwriter.
- `POST /api/hub/servers/:id/friends` (same fields): a new kinwriter in that server.
- `PATCH /api/hub/servers/:id` with `name`, and/or `friends` (a new order).
- `PUT /api/hub/servers/order` with `ids`.
- `DELETE /api/hub/servers/:id`: the server and its kinwriters (to the trash).
- `DELETE /api/hub/friends/:id`: one kinwriter (to the trash).
- `POST /api/hub/friends/:id/move` with `serverId`, or nothing for a server of their own.

Each kinwriter's app has the same API as before. Its new settings are `friendAvatar` (an emoji, or "" for their initial) and `friendColor` (a hue from 0 to 359, or -1 for the theme's).

## Tests

`test/hub.test.ts`:

- starting fresh, and upgrading an existing data folder;
- routing;
- a new kinwriter with copied profiles and preferences but their own identity and a clean slate;
- a kinwriter never seeing another's notebook, messages or prompt;
- several kinwriters in one server, reordering them, and moving one out;
- renaming and reordering servers, kept after a restart;
- deleting to the trash (including the first kinwriter), and the last one can't go;
- bad input.

In a real browser, on desktop and phone sizes: the rail; the kinwriter menu (avatar and colour); a new server from Surprise me; adding a kinwriter to a server, with both sections in the sidebar; and switching by another kinwriter's channel and by the rail.
