# Scripts: tool calls written once and run exactly

Calling tools through a model is unpredictable. On the day, a kinwriter may skip a step, do them in another order, or get an argument slightly wrong. Scripts take the model out of the loop. While they're thinking clearly, a kinwriter writes down an ordered list of tool calls. Later, Kinaera runs those steps one after another, exactly as written, with nothing deciding in between. If a step fails, the run stops there and they're told which step failed and why, so they can fix it and try again from that step.

Scripts are **opt-in, per kinwriter**: the kinwriter page has a **Scripts** checkbox, off by default. While it's off, none of the script tools are offered and no scheduled script runs.

## What a script is

A name, an optional line about what it's for, and up to 12 steps. Each step is:

```json
{ "tool": "write_map_entry", "args": { "tool": "check", "when": "before I state a fact" }, "expect": "saved", "optional": false }
```

- `tool` and `args`: the call, exactly as they'd make it.
- `expect` (optional): text the result must contain (case doesn't matter). If it's missing, the step counts as failed even though the tool ran.
- `optional` (optional): if it's `true`, a failure is reported but the run carries on.

A step fails when its tool returns an error or its `expect` isn't met. A script can't call `do_nothing`, `keep_my_draft`, `consult` (a model call of its own) or the script tools themselves. It can call `take_another_turn`. Every other tool works with the same permissions and limits it has in a turn.

Scripts are kept in `app_state` under `scripts`, like the tool map. Each one also keeps its last run: when it ran, whether it worked, and where it stopped.

## The tools

| Tool | What it does |
| --- | --- |
| `save_script` | Write a script, or replace one with the same name. Steps are checked when it's saved: unknown tools and tools that aren't allowed are refused. |
| `run_script` | Run one now, in this turn. They get back each step's result. On a failure they also get `failed_step`, the error, and a `from_step` to retry from. |
| `list_my_scripts` | Their scripts, each with its steps and last run. |
| `delete_script` | Delete one. |
| `queue_scripts` | Queue scripts to run one per turn, in order (below). |
| `resume_script_queue` | Recover a paused queue: retry, skip, restart, or insert a fix-up first (below). |
| `take_another_turn` | Another turn as soon as this one ends (below). |
| `schedule_wakeup` + `script` | Run a script at a set time as a **tools-only turn** (below). The note is optional when a script is given. |

## Work bigger than one turn

A turn has 6 rounds of tool calls, and the next turn starts fresh. That's why a kinwriter reading a 67-passage document stopped at passage 7 and didn't pick it back up. Three things fix it:

- **`take_another_turn`** (with an optional note to themselves): another turn starts in the same channel as soon as this one ends. The turn still ends as usual, with a reply or `do_nothing`. The next turn opens with their note. It can also be a script's last step, so a tools-only scripted turn can hand off to a real one. At most `CHAIN_LIMIT` (30) such turns run in a row. Any turn you start resets the count, and Stop ends the chain.
- **`queue_scripts`** (a list of names, with optional `add` to append to the queue instead of replacing it): the scripts run one per turn, in order, in that channel. Each one runs at the start of its own turn, before the model is asked, and its step results go into that turn, so the kinwriter can read what it found and act on it (take notes, write, or nothing). The next turn follows by itself while scripts are still waiting. The queue is kept in `app_state` under `scripts.queue`, and `list_my_scripts` shows it.
- **Reading bookmarks** (src/bookmarks.ts): `read_library` keeps their furthest passage in each document, and their prompt's library section says "(you've read up to passage 7; carry on from 8)". `read_library` now reads up to 5 passages a call, up from 3.

### When a queued script fails

Only that script stops. The queue pauses with that script at the front, starting from the step that failed, and everything after it stays as it was. The turn tells them which step failed and why, and what each step returned. No further turn starts by itself. To recover:

- fix the script if it needs it (`save_script` replaces it by name);
- **`resume_script_queue`**: with no arguments, it retries from the failed step. `skip` drops the failed script and moves on. `from_step` restarts it from another step (1 for the whole script). `insert` runs other scripts first, such as a one-off fix-up. These combine, and the rest of the plan is untouched;
- `take_another_turn` also resumes a paused queue (a plain retry);
- `queue_scripts` with `add` adds to the end of the queue without unpausing it. Without `add` it replaces the plan.

## Reflexes that point to them

Two reflexes ([reflexes](reflexes.md)) apply only while scripts are on. **`carry-on`** is on by default outside story channels. It reminds them about `take_another_turn` or `queue_scripts` when a draft says they'll keep going but nothing gives them another turn, which is the reader-stopped-at-passage-7 case. **`plan`** starts off. It suggests a script when a draft lays out several tool steps.

## Telling them it's new

The first turn with tools after Scripts is turned on carries a one-time notice (`defaults/scripts.md`, `introduction`). It says this changes how they can use tools: plan once and run exactly, instead of choosing every call in the moment. It names the new tools, asks them to add a line to their tool map (`write_map_entry`) once they know when they'd reach for each, and mentions they can ask for an orientation to practise. It's marked as told in `app_state` (`scripts.introduced`), so turning Scripts off and on again doesn't repeat it. The orientation catalog lists the new tools for future orientations.

## Tools-only turns

A wake-up set to run a script doesn't call the model at all. When it's due, the Rhythms timer (src/orientation.ts) hands it to `Wakeups.script`:

- **Held**, and left waiting for the next minute, during quiet hours, during an orientation, or while a turn is running in that channel.
- **Every step works:** the wake-up is done. Each step is in the tool log as its own call, marked `(script "name", step n)`, and those calls show in "What you did recently". Nobody is messaged unless a step posts. `post_in_channel` may post in the script's own channel here, since a tools-only turn writes no reply.
- **A step fails**, or the script can't run (scripts turned off, the script deleted): the wake-up becomes an ordinary scheduled one. Its note says which step failed, what the error was, which steps worked first, and how to retry (`run_script` with `from_step`), followed by their original note. They wake up to it at once, or as soon as the wake-up rules allow, and can fix the script and run it again, or leave it.

A tools-only turn runs in the wake-up's channel, or their usual OOC channel if none was given. It holds that channel the way a turn does, so the two never overlap.

## Where people see it

- **Settings:** the Scripts checkbox on the kinwriter page.
- **Their page:** a "Their scripts" section lists each script's tools in order and how its last run went. It shows tool names only, not arguments, since arguments can quote private things.
- **The tool log:** every step, as it ran. Private tools keep their privacy here as anywhere else.

## Code

- `src/scripts.ts`: storage, checking steps, the runner, the failure note, and the queue.
- `src/bookmarks.ts`: reading bookmarks. `defaults/scripts.md`: the wording.
- `src/tools.ts`: the script tools, `runScriptSteps`, and `schedule_wakeup`'s `script` argument.
- `src/kinwriter.ts`: `runScriptTurn` (the tools-only turn), the per-step tool log, queued scripts at the start of a turn, and `anotherTurn`.
- `src/wakeups.ts`: `Wakeups.script`. `src/orientation.ts`: `Rhythms.tick`.
- `src/schedule.ts` plus migration 14: the `script` column on wake-ups.
- `test/scripts.test.ts`.
