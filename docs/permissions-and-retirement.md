# Stage 8: standing permissions and retirement

Two extras: standing permissions, and retiring a kinwriter.

## Standing permissions

`src/standing.ts`, with the wording in `defaults/permissions.md`. On a kinwriter's page, under **Standing permissions**, you can pre-approve things so they don't have to ask each time:

- **Delete their channels without asking.** They get a `delete_channel` tool in place of proposing it. It never works on group channels, DMs, the practice channel, or the channel they're in.
- **Edit your notebook entries directly** where they'd otherwise suggest a change. Entries you've locked stay locked.

**How a grant works:**

- Every grant and every revocation goes into the intervention log ("What you've changed"), which they read.
- Their prompt lists what they're allowed right now, under **Standing permissions**.
- Grants are kept per kinwriter, like everything else about them.

## Retirement

Archive a kinwriter instead of deleting them. Their settings (kinwriter card → **Settings…**) have **Archive…**:

1. They get **one last turn**, in their OOC channel, to write a note if they want to. It's asked for, so the hard rules don't apply. The wording is in `defaults/retirement.md`.
2. Then they're **set aside whole**, with every message, note and memory kept. They leave their server, their timers stop, and they aren't loaded until restored.
3. Their note is kept with the archive. You see it once when you archive them, and again in **server settings → Archived kinwriters**.
4. **Restore** brings them back into that server, exactly as they were.

**Delete for good** stays possible: from their settings, or for an archived kinwriter from server settings. It's behind a clear warning and typing their name, and their files still go to the data folder's trash. You can't archive or delete your last active kinwriter.

While a kinwriter is archived, their group channels carry on without them. Messages posted meanwhile aren't mirrored to their copy.

## API

- `PUT /api/permissions/:key` with `{ granted }`, on a kinwriter's app. Their page (`GET /api/friend-page`) lists `permissions`.
- `POST /api/hub/friends/:id/archive` returns their `note`.
- `POST /api/hub/friends/:id/restore`, with an optional `serverId`.
- `GET /api/hub` lists `archived` kinwriters, with their name, face and note.

`hub.json` keeps an archived kinwriter's `archived` record: when, their note, their name, avatar and colour.

## Tests

`test/standing.test.ts` covers:

- granting and revoking both permissions, logged and in their prompt;
- `delete_channel`'s limits;
- editing your entries directly, with locked entries staying locked;
- archiving with a last note, and restoring with everything intact;
- the last kinwriter can't be archived;
- deleting an archived kinwriter for good.
