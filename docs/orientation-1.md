# Orientation stage 1: "friend" becomes "kinwriter"

The first stage of [the orientation redesign](../KINAERA_ORIENTATION.md). Every word you see now says **kinwriter**. This covers:

- the app: buttons, labels, hints, errors and the server's log lines (`[kinwriter] turn started…`);
- the prompts in `defaults/`, so the model is your kinwriter too: "You are the user's kinwriter, the writer they roleplay with";
- the docs and the README;
- the code: `src/kinwriter.ts` (was `friend.ts`) with the `Kinwriter` class, `public/js/kinwriter-page.js` and `kinwriter-self.js`, `defaults/kinwriter.md` and `defaults/kinwriters.md`, `docs/kinwriters.md`, and every function and type name;
- the DM tool, now `message_kinwriter`, whose parameter is `kinwriter`. The same goes for `note_relationship`.

Natural phrases keep the word "friend": "like texting a friend", "an old friend".

## What stays as it was

Values already saved in your data keep their old names. They're internal labels you never see, and keeping them means nothing in an existing data folder needs migrating:

- `"friend"` as a message's author, an entry's owner, who edited or deleted something, and so on, in the database;
- the settings keys `friendName`, `friendPrompt`, `friendAvatar` and `friendColor`;
- the `friends` lists in `hub.json`, and each kinwriter's folder, `friends/<id>/`;
- the API routes (`/api/friend-page`, `/api/hub/friends/…`) and the page's element ids;
- the earlier stage docs in `docs/`, which describe what was built at the time.

**If you edited the wording of `friends.md`** in Settings → Prompts, that file is now `kinwriters.md`. The edit is still in `data/prompts.json` under its old name, so make it again there.

## How it was done

A small tokenizer read each source file and treated each part by kind:
- **Names in code** were renamed, except the saved keys above.
- **Comments and sentences in strings** were reworded.
- **Strings that are keys, ids, routes or stored values** were left alone.
- **SQL strings** only had their `$placeholders` renamed, to match.

All 558 tests pass. A data folder from before the rename opens with its messages, settings and channels intact.
