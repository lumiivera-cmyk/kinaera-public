# The heartbeat

The heartbeat is a timer that now and then gives your kinwriter a free moment, even with the app closed. What they do with it is up to them: text you, act with their tools, or nothing at all. Notifications are borrowed from Kitsikai.

(An earlier design had the kinwriter write ideas, had Jev grade them, and kept the rest in an "idea drawer". All of that is gone: whether something is worth saying is the kinwriter's call.)

## Using it

- **Settings → Your kinwriter reaching out → Heartbeat**: off by default, or about every 10, 15 or 30 minutes, every hour, every 2, 4, 6, 8 or 12 hours, or once a day. Each gap varies by ±20%, so it never feels like clockwork. The server checks every minute whether a beat is due. A short heartbeat only helps with a short cooldown: every beat still goes through the hard rules below.
- **Heartbeat check** (same section): pick a cheaper profile or roulette, and it reads each beat first and only answers whether your kinwriter would use the moment. On a no, nothing else is asked; on a yes, the model that writes OOC takes the moment as usual. "No check" (the default) sends every beat straight to that model. Worth it when your OOC model is expensive to read a whole prompt with.
- **Set quiet hours** in the same section, so it never wakes you at night.
- **Beat now** (same section) runs a heartbeat straight away, to try it. The rules still apply.
- **On your phone** (Termux), install Termux:API for notifications (see the README). When your kinwriter writes on their own and the app isn't on screen, you get a notification, "Arlo in #ooc", and tapping it opens that channel.

## How a beat works

`src/heartbeat.ts`:

1. **The hard rules** (`Wakeups.blocked` in `src/wakeups.ts`), exactly as for any wake-up: chattiness (off stops the heartbeat), quiet hours, the cooldown, never a third time without you writing (one double text is fine), and not within 30 minutes of the last message. Most beats stop here, costing nothing. These are plain code, with no model calls.
2. **The check** (only with a heartbeat check chosen): one request to that profile, with no tools, plus a question asking for one word, YES or NO (`heartbeat-check` in `defaults/time.md`). It reads a short version of the wake-up prompt (`buildCheckPrompt` in `src/prompt.ts`), with only what the decision rests on: who they are and their self-page's short version, their note on you and how proactive they'd like to be, the time and their wake-ups, their drafts, what's waiting for their review, what they did recently and asked of you, notices, the tools the turn would have (names only, with their own tool-map note on any they've noted, so a yes covers using tools on their own and not just texting you), why they're up, the profile's model notes, and the last 8 messages. The server and notebook overviews, channel summaries, the journal, style, tool guidance and the tools' full descriptions are left out, so each check costs a fraction of a turn. The first YES or NO in the answer decides, and an answer with neither is a no. A no goes in the wake-up log as quiet ("The heartbeat check (…) said not now"), but isn't a turn: it starts no cooldown. If the request fails, the beat is logged as failed, without asking the main model.
3. **A free moment.** If the rules pass (and the check said yes), your kinwriter gets a wake-up turn in your OOC channel, with the reason "heartbeat". Their prompt says they're checking in on their own, how long it's been since you wrote, and what's waiting. They can write, use tools, or call `do_nothing` (or reply `[nothing]` without tools). Every turn goes in the wake-up log.

## Notifications

`src/notify.ts`:

- When a wake-up or heartbeat writes to you and the app isn't on screen, the server runs Termux:API's `termux-notification`. It's titled "Arlo in #ooc", with the message as the text, and tapping it opens the app at that channel. There's one notification per channel, and a newer one replaces the older.
- **On screen?** The app tells the server (`POST /api/presence`) when it's shown or hidden, and every 15 seconds while it's shown. No word for a minute counts as not on screen.
- **Staying awake**: with the heartbeat on, the server runs `termux-wake-lock`, so Android doesn't pause it.
- On a computer (no Termux), notifications are quietly off, and Settings says so.

## Where it's stored

When the next beat is due is kept in the `app_state` table (`src/appstate.ts`).

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `heartbeatHours` | 0 (off) | About how often the heartbeat beats, in hours (5 minutes to 168 hours: 0.25 is every 15 minutes). Changing it starts the count again |
| `heartbeatAssignment` | "" (no check) | The profile or roulette that checks each beat first (`profile:<id>` or `roulette:<id>`). Only the heartbeat is checked: other wake-ups go straight to the model that writes OOC. Part of "Your kinwriter reaching out", so it can be set just for one kinwriter |

The heartbeat also follows the wake-up settings: chattiness, quiet hours, the cooldown.

## API

- `POST /api/presence` with `visible`: the app is (or isn't) on screen.
- `POST /api/heartbeat`: beat now, and wait for it. Returns what happened (`beat`).
- `GET /api/state` also has `notifications` (whether they work here) and `heartbeatNext`.

## Tests

`test/heartbeat.test.ts`: presence timing out; off and not-yet-due beats; the rules stopping a beat before any cost; a free moment your kinwriter writes in (with a notification, and no Jev call); one they spend quietly; the heartbeat check saying no (one cheap request, no tools, a short prompt with only the last 8 messages) and yes (then the main model); only a clear yes counting; other wake-ups skipping the check; no notification while the app is on screen; never mid-conversation; the API.
