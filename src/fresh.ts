/**
 * A fresh start: `bun run fresh`.
 *
 * Sets every kinwriter's memory aside and starts Kinaera over. The app then
 * opens on "Meet your new kinwriter": you choose their name, face, who they
 * are and their tastes (or roll them), and their first turn of their own
 * is an orientation. Nothing
 * is deleted: the whole data folder is renamed to `data-old-<date>`, so you
 * can go back by stopping Kinaera and renaming it back.
 *
 * What carries over, because it's yours rather than theirs:
 *   - your connection profiles and roulettes (from your first kinwriter in
 *     the sidebar who isn't archived);
 *   - your preferences (models, Jev, reaching out, the heartbeat, quiet
 *     hours, texting, the look), but not anything that's the kinwriter
 *     themselves (name, identity, how they write);
 *   - your own themes and background pictures;
 *   - your edits to the prompts' wording (Settings → Prompts).
 * Your API key is in `.env`, outside the data folder, so it's untouched.
 *
 * Stop Kinaera first: this refuses to run while it's running. With
 * DEVELOPER_PANEL=1, the developer panel can do the same from inside the
 * app, and browse, export and import the kinwriters in old folders
 * (src/datafolders.ts).
 */

import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { freshSource, serverState, startFresh } from "./datafolders.ts";
import { KINWRITER_KEYS } from "./hub.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const dataDir = config.dataDir;
  if (!existsSync(dataDir) || freshSource(dataDir) === null) {
    console.log(`There's no Kinaera data in ${dataDir} yet: just run "bun start".`);
    return;
  }

  // Refuse while the server is running: it has the database open. (The
  // developer panel's Start fresh does this from inside the app.) Only a
  // refused connection means it's stopped.
  const state = await serverState(config.host, config.port);
  if (state === "running") {
    console.log("Kinaera is still running. Stop it first (Ctrl+C where it runs), then run this again.");
    process.exitCode = 1;
    return;
  }
  if (state === "unknown") {
    console.log(`Couldn't tell whether Kinaera is running (at ${config.host}:${config.port}). Make sure it's stopped, then run this again.`);
    process.exitCode = 1;
    return;
  }

  const { aside, profiles } = startFresh(dataDir, { kinwriterKeys: KINWRITER_KEYS });
  console.log("Done: Kinaera starts fresh. Open the app to make your new kinwriter.");
  console.log(`Kept: your API key, ${profiles} connection profile${profiles === 1 ? "" : "s"} and roulettes, your preferences, your themes and background pictures, and your prompt edits.`);
  console.log(`Everything else is set aside, not deleted, in ${aside}`);
  console.log("When you're sure you won't want it back, you can delete that folder. Now run: bun start");
}

await main();
