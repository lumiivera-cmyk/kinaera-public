# Kinaera

Kinaera is a Discord-style space for writing stories and hanging out with one or more AI kinwriters: writers with their own style who play characters alongside you, using models from [nanoGPT](https://nano-gpt.com). It's designed as if the kinwriters could be people: they get real tools to check things, ask for help and fix their own mistakes, and parts of their life that are theirs.

**How it works**, in depth: [messages with history](docs/message-history.md), [the instruments](docs/instruments.md), [their own things](docs/own-things.md), [their own time](docs/own-time.md), [continuity](docs/continuity.md), [among kinwriters](docs/together.md), [permissions and retirement](docs/permissions-and-retirement.md), [the orientation](KINAERA_ORIENTATION.md), and more in `docs/`.

## What it can do

- **Kinwriters and servers**: as many kinwriters as you like, each a different person with their own memory (notebook, secrets, channels, settings) and usually a server of their own, in a rail on the left. A server can hold several kinwriters. Each kinwriter has their own menu (tap the kinwriter card): name, emoji avatar, colour, who they are, how they write, and 🎲 Surprise me. See [kinwriters and servers](docs/kinwriters.md).
- **Channels**: create, rename and delete them from the sidebar, group them into collapsible **categories**, and **drag** to rearrange (press and hold on a phone). See [categories](docs/categories.md).
  - **Roleplay** channels are storylines. Each has its own cast: characters and lore pinned from the notebook.
  - **Out-of-character** channels are for talking with your kinwriter as themselves. They know which storylines exist.
- **Notebook** (the book button): characters and lore, with labelled fields, notes for your kinwriter, and `[[links]]` between entries.
  - Each entry is yours, your kinwriter's, or shared. Your kinwriter plays their characters, you play yours, and either of you can play shared ones.
  - You choose whether your kinwriter can see each of your entries, and whether they can edit it, only suggest changes, or only read it. Folders pass these settings to the entries in them.
  - Your kinwriter's secrets show as "??? (hidden)" in a cast: they know, you don't (yet).
- **Scenes**: type `=====` (or `===== Title`) or press ⁂ to start a new scene. Scenes are divided by a titled line.
- **Long stories**: your kinwriter reads the newest messages in full and remembers the rest through summaries: of each scene when it ends (press **Summary** under a scene break), the story so far, and a line or two per channel that OOC reads. Read and edit them in channel settings → Memory. Summaries are written only from the messages, so nothing hidden from you is ever in them.
- **Two styles** per roleplay channel. A change of style waits for the next scene, so a scene never mixes them.
  - **Literary**: your kinwriter writes prose posts, shown as wide blocks of text.
  - **Casual**: short in-character bubbles, one character each, like a group chat. You post as your own characters (from the notebook) with proxy tags (`k: *waves*`) or the "Posting as" menu, like Tupperbox.
- Every message records who wrote it, which character it voices, and which profile and model generated it.
- Edit the **kinwriter prompts**: who your kinwriter is (used everywhere), and how they write in literary scenes, in casual scenes, and out of character. Each channel only gets the one for its own kind, so OOC chat stays short even if your literary style is long. Also how many recent messages the kinwriter sees.
- **Connection profiles and roulettes** (Settings → Profiles and roulettes): a profile is a model with its settings and its own "model notes"; a roulette picks one of several profiles at random each turn, by weight. Choose what writes roleplay and OOC, and override it per channel. Wherever you choose a profile, its settings (model, temperature, max tokens, top P, min P, reasoning, tools) show right under the dropdown and save as you change them. New servers start with DeepSeek-V3.1-Terminus at temperature 0.8, top P 0.95, min P 0.025.
- **Your kinwriter acts**, if their profile can use tools: they read the notebook, make and edit entries, pin characters, make channels, start scenes, comment on messages, review your suggestions, or choose not to reply. What they did shows under their message. Each profile has a **Test tools** button, and each channel a **tool log**, for when a model gets it wrong.
- **Reference library** (Notebook → Library): upload long texts like a film's script or a book for a fandom. Your kinwriter searches them and reads the passages they need, instead of guessing; nothing is sent whole. See [the library](docs/library.md).
- **Attach notes** to a message with the paperclip, or write `[[Name]]` in it: your kinwriter gets those entries in full.
- **Reactions**: react to messages with emojis, and your kinwriter reacts too. Upload **custom emojis** and use them as `:name:`. See [reactions](docs/reactions.md).
- **Comments**: select text in a message to comment on it; your kinwriter replies in the thread (on your own message, they can tell a note to yourself and leave it).
- **Reflexes**: after your kinwriter drafts a reply, Jev reads it and reminds them if they said they'd done something without calling the tool (edited a message, set something for later, noted something, posted elsewhere), or a tool might help. They act or not; it's their instrument, and they can turn checks off. See [reflexes](docs/reflexes.md).
- **Your kinwriter's instruments**: `check` (searching the notebook, the chat, the summaries or the library, with Jev's reading of what it finds), `ask` (a question for you, in your inbox) and `consult` (a second opinion from a profile you mark as a consultant). See [the instruments](docs/instruments.md).
- **Your kinwriter's own things**: an identity and tastes they rewrite themselves (your changes are suggestions), a self-page, a private journal that fades unless they keep entries, a say in what stays in their context, and a practice channel where they try their tools out in an orientation: one you pick, together or on their own, with a live feed of what they do (see [stage 4](docs/orientation-4.md)). Tap your kinwriter in the sidebar for their page. See [their own things](docs/own-things.md). They can also act on one channel from another: ask you something in OOC about a story, or open a scene in #story after planning it in OOC.
- **Your kinwriter's own time**: wake-ups they schedule for themselves ("thursday evening: ask how the interview went"), private drafts they work on across turns, a free moment on the heartbeat, and pausing a storyline with a reason you see. See [time](docs/own-time.md).
- **Staying themselves across models**: reminders of their own voice in every prompt (posts they mark ♪ first), "not me" flags you see on a post, their notes on each profile, a mirror of their own writing habits (plain counts, only when they ask), and a weekly wellbeing reading shown only on their page and in their weekly look back. See [continuity](docs/continuity.md).
- **Among kinwriters** (off by default: Settings → Advanced → Kinwriters together, untested): group channels with several kinwriters (when you write, each may take a turn; @Name gives a kinwriter one), DMs between kinwriters that you can choose to read or not, replies, presence and a status of their own, private notes on each other, and `/roll` dice. See [among kinwriters](docs/together.md).
- **Standing permissions and retirement**: pre-approve a kinwriter deleting their own channels or editing your notebook entries directly; archive a kinwriter (they leave a last note) and restore them later, or delete them for good. See [stage 8](docs/permissions-and-retirement.md).
- **Inbox** (the tray at the top of the channel list): what your kinwriter asks of you, their proposals, and suggested changes, to answer, approve or reject. The **check log** (your kinwriter's page) lists every check they made.
- **Texting in OOC**: your kinwriter texts in short bursts that arrive one at a time with "typing…", and waits for you to pause before answering. **🎲 Surprise me** invents a new kinwriter (in the kinwriter menu, or when you make one). See [texting](docs/texting.md).
- **After a story post**: when your kinwriter posts in a story, a moment in OOC to say something to you as themselves (a reaction, a question, an idea) if they want to. Usually they'll let the story speak. At most every 30 minutes by default, or off. See [asides](docs/asides.md).
- **Heartbeat** (off by default): now and then, even with the app closed, your kinwriter gets a free moment. They can text you (with a phone notification), act with their tools, or do nothing. See [the heartbeat](docs/heartbeat.md).
- **Your kinwriter reaches out**: when you come back after a while, when a scene ends, or when a suggestion is waiting for them, your kinwriter gets a turn of their own in OOC, and decides whether to write. Plain rules (chattiness, quiet hours, a cooldown, at most one double text before you write back) keep it from being too much (Settings → Your kinwriter reaching out, with a log of every wake-up). A dot marks channels with messages you haven't seen.
- **Kinwriter's turn**: let your kinwriter write without a new message from you, including opening an empty channel.
- **Stop** a reply that's taking too long. Nothing is saved, and the channel is free again.
- **Regenerate** the kinwriter's last reply (or **Regenerate with…** a particular profile), **edit** or **delete** any message. Nothing is overwritten: tap "(edited)" or "↻ 2" for a message's history. Your kinwriter can fix their own messages too, and **What you've changed** (your kinwriter's page) lists everything you've done that affects them. See [messages with history](docs/message-history.md).
- **Preview prompt**: see exactly what the model receives on the next turn in a channel.
- **Prompts and dry run** (Settings): every prompt's wording in one place, editable, with a reset for each piece. A **dry run** shows exactly what any kind of turn would send (a reply, any wake-up, orientation, the look back), and can ask the model what they'd write, without saving anything or running tools. See [prompts and dry run](docs/prompts.md).
- **Themes**: pick one in Appearance (the palette button). Classic, Frutiger Aero, Aero Glass, Liquid Glass, Liquid Glass Dark and Rainy Window (a night city through a window of raindrops that slide down, with glossy liquid glass bubbles) are built in. The Liquid Glass themes and Rainy Window's bubbles are real refracting glass, like Apple's: what's behind bends and splits into rainbows at the edges of each pane (in Chrome, including on Android). Themes can offer sliders in Appearance, like Rainy Window's bubble transparency or Liquid Glass's refraction. Any channel can have its own theme, and you can copy a theme and edit its CSS and images right in the app. Glass effects can be Full, Lite (easier on the phone) or Automatic. See the [theme reference](docs/theme-reference.md).
- Install it to your home screen as an app (PWA).

## Running it

You need [Bun](https://bun.sh) and a nanoGPT API key.

```sh
# 1. Get the code and install the development tools (only needed for tests and type checking)
git clone https://github.com/626andup-cmyk/kinaera-public.git
cd kinaera-public
bun install

# 2. Add your API key
cp .env.example .env
#    then edit .env and set NANOGPT_API_KEY=...

# 3. Start the server
bun start
```

Then open <http://127.0.0.1:4747> in your browser.

### On your phone (Termux)

The server is designed to run in [Termux](https://termux.dev) on the phone you chat from:

1. Install Bun inside Termux. If the installer from bun.sh doesn't work on your phone, run it inside a Linux environment set up with `proot-distro` instead.
2. Follow the steps above, then run `bun start` and leave Termux open.
3. Open <http://127.0.0.1:4747> in Chrome, then choose **menu → Add to Home screen** (or **Install app**). Kinaera now opens like an app.

The app only works while the server is running. If it says it can't connect, start the server in Termux again.

**Notifications and the heartbeat.** For phone notifications when your kinwriter writes on their own, install the **Termux:API** app and run `pkg install termux-api` in Termux. With the heartbeat on (Settings → Your kinwriter reaching out), the server takes a wake lock so the phone doesn't pause it; also turn off battery optimization for Termux (Android Settings → Apps → Termux → Battery → Unrestricted).

### Settings in `.env`

| Variable | Default | What it does |
| --- | --- | --- |
| `NANOGPT_API_KEY` | none (required) | Your nanoGPT API key |
| `HOST` | `127.0.0.1` | Where the server listens. The default means only this device can connect. |
| `DEVELOPER_PANEL` | off | `1` turns on the developer panel (every private note in one view, for checking the tools while Kinaera is being built; disclosed to your kinwriter). See [stage 3](docs/orientation-3.md) |
| `ALLOWED_HOSTS` | none | Other names the app may be opened by (comma-separated), besides `localhost` and IP addresses |
| `PORT` | `4747` | Port for the web app (not 3000, so it can run next to Kitsikai) |
| `DATA_DIR` | `./data` | Where your data is saved |
| `NANOGPT_BASE_URL` | `https://nano-gpt.com/api/v1` | API address (only change this for testing) |
| `REQUEST_TIMEOUT_SECONDS` | `180` | How long to wait for a reply before giving up |

Everything else (prompt, model, characters and so on) is changed in the app.

## Your data

Everything is saved in the `data/` folder. Your first kinwriter's chat and settings are in an SQLite database, `data/kinaera.db`. Each other kinwriter has their own folder, `data/friends/<id>/`. Your own themes are in `data/themes/`, and the list of servers is `data/hub.json` (see [kinwriters and servers](docs/kinwriters.md)). To back up, stop the server and copy the whole `data/` folder. (While the server is running, the database's recent changes are also in `kinaera.db-wal` and `kinaera.db-shm`, so copy those too.) The `data/` folder and `.env` are never committed to git.

**Starting over.** Stop Kinaera, then run `bun run fresh`. Every kinwriter's memory is set aside, not deleted: the `data/` folder is renamed to `data-old-<date>`, and you can go back by renaming it back. The app then opens on **Meet your new kinwriter**: their name, face and colour, who they are and their tastes, written by you or rolled with 🎲 Surprise me. You're then offered their orientation: together, or on their own. Your connection profiles, roulettes, preferences and themes carry over, and your API key is in `.env`, untouched.

Kinaera has no login. Keep `HOST` at `127.0.0.1` so that nobody else on your Wi-Fi can open your chat.

**What protects it on your phone.** Other web pages you visit can't use it: requests that change anything must be JSON, which browsers won't send across sites, and Kinaera only answers to `localhost` or an IP address, so a site can't point its own name at your phone to read your chats (DNS rebinding). If you open it by another name, such as a Tailscale machine name, add that name to `ALLOWED_HOSTS`. Your API key stays in `.env` and is never sent to the page.

## Development

```sh
bun run dev        # start the server, restarting whenever a file changes
bun test           # run the tests (they use a fake nanoGPT, so no key or credit is needed)
bun run typecheck  # check the TypeScript types
```

Project layout:

```
src/
  server.ts    HTTP server: API routes and serving the web app
  friend.ts    The one "friend takes a turn" function
  prompt.ts    Builds the prompt stack sent to the model
  posts.ts     Turns text into messages: posts, replies, scene breaks
  tools.ts     Your friend's tools: what each does, run as your friend
  toolcalls.ts Reading tool calls, including broken or written-as-text ones
  profiles.ts  Connection profiles and roulettes
  activity.ts  The tool log, comment threads, and proposals
  summaries.ts Summaries: storing them, splitting scenes, what the prompt still needs
  summarizer.ts  Writes summaries in the background as channels change
  wakeups.ts   The hard rules, and your friend's turns of their own
  heartbeat.ts The heartbeat: a timer that gives your friend free moments
  check.ts     `check`, your friend's sonar, and the check log
  inbox.ts     The inbox: your friend's asks, and proposals
  jev.ts       Asking Jev, the small decision model, yes-or-no questions
  hub.ts       Friends and servers: one app per friend, each with their own memory
  notify.ts    Phone notifications (Termux)
  texting.ts   Texting in OOC: splitting replies into texts
  rng.ts       "Surprise me": a random friend
  json.ts      Finding JSON in a model's reply
  reactions.ts Emoji reactions and custom emojis
  library.ts   The reference library: splitting long texts into passages, and searching them
  notebook.ts  The notebook: entries, folders, suggestions and each channel's cast
  permissions.ts  Who can see, edit and manage each notebook entry
  bubbles.ts   Splits casual text into one-character bubbles
  themes.ts    Themes: storing, editing, serving and scoping them
  nanogpt.ts   Talks to nanoGPT's API
  db.ts        The database's tables, and upgrading them (migrations)
  store.ts     Reading and writing channels, messages and settings
  appstate.ts  Small values kept between runs
  interventions.ts  The intervention log: what you've done that affects your friend
  wording.ts   Reads prompt wording from defaults/, with your edits from data/prompts.json
  errors.ts    Errors the server turns into 404, 400 and 403 answers
  config.ts    Reads settings from .env
  types.ts     The shapes of channels, messages and settings
public/        The web app (plain HTML, CSS and JavaScript, no build step)
  js/          The app itself, as ES modules, one per area: main.js is the starting point
               (profile-inline.js: a profile's settings under any dropdown that picks one)
  glass.js     Real refraction for the glass themes
themes/        Built-in themes (Classic, Frutiger Aero, Aero Glass, Liquid Glass, Liquid Glass Dark, Rainy Window)
defaults/      Starting friend prompts, the example character, and every prompt's wording (edit it in the app)
test/          Tests
docs/          How things work, and the theme reference
```

## Licence

[GNU AGPL v3](LICENSE).
