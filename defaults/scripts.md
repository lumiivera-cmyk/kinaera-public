# Scripts

The wording around scripts (src/scripts.ts) and the turns your kinwriter
asks for themselves: take_another_turn, and a script queue, which runs one
queued script at the start of each turn and shows them what it did.
`{placeholders}` are filled in by Kinaera.

## introduction

<!-- Added once to the kinwriter's notices, on a turn with tools, after you
turn on scripts for them. -->

New: the user turned on scripts for you. This changes how you can use your tools. Until now, every tool call was a choice made in the moment, one round at a time, and a turn only has a few rounds. Now you can plan instead: write down tool calls in order once (save_script, up to 12 steps, each with exact arguments), and Kinaera runs them exactly as written, with no guessing in between (run_script). If a step fails, the run stops there and tells you which step and why, and you can fix it and carry on from that step.

For work bigger than one turn: queue_scripts runs your scripts one per turn, in order, and shows you each one's results in its turn, to read and act on. A failed step pauses only that script, and the rest of your plan stays queued: resume_script_queue retries it, skips it, restarts it, or puts a fix-up script first. take_another_turn gives you another turn as soon as this one ends, and it can also be a script's last step. schedule_wakeup can run a script at a set time as a tools-only turn: you only wake up if a step fails. Your place in each library document is kept now too, and read_library reads up to 5 passages at a time.

Try them when they'd help, and write a line for each in your tool map (write_map_entry) once you know when you'd reach for it. If you'd like time to practise, start_orientation asks the user for one.

## queue-ran

<!-- Opens a turn the kinwriter asked for when their next queued script ran
first and every step worked, followed by each step's results. {name} is the
script. -->

(Your queued script "{name}" just ran, before this turn. Every step worked. What each step returned:)

## queue-failed

<!-- Opens a turn the kinwriter asked for when their queued script stopped
partway, followed by each step's results. {name} is the script, {step} the
failed step, {error} what went wrong. -->

(Your queued script "{name}" just ran, before this turn, and stopped at step {step}: {error} Only this script stopped: the queue is paused at that step, and everything after it is still queued as it was. Fix the script if it needs it (save_script), then call resume_script_queue: with nothing, it runs again from step {step}; or "skip" it, restart it "from_step" another step, or "insert" a fix-up script first. Or leave the queue paused. What each step returned:)

## queue-skipped

<!-- Opens a turn the kinwriter asked for when the next script in their queue
no longer exists and was skipped. {name} is the missing script. -->

(Your queued script "{name}" is gone, so it was skipped.)

## queue-left

<!-- Added after a queued script's results at the start of a turn the
kinwriter asked for, when more scripts are still waiting. {count} is how many.
-->

({count} more queued: the next runs at the start of your next turn, by itself.)

## queue-done

<!-- Added after a queued script's results at the start of a turn the
kinwriter asked for, when it ran fine and was the last one queued. -->

(That was the last queued script.)

## again-note

<!-- Added to the start of a turn the kinwriter asked for, when they left
themselves a note asking for it. {note} is that note. -->

Your note for this turn: "{note}"

## again-nudge-tools

<!-- Ends the message that starts a turn the kinwriter asked for with take
another turn or a script queue, when they have tools that turn. -->

(No new message from me: this is the turn you asked for. Carry on with what you planned. Write only if you want to, or call do_nothing. If you need yet another turn after this one, call take_another_turn again.)

## again-nudge

<!-- Ends the message that starts a turn the kinwriter asked for, when they
have no tools that turn. -->

(No new message from me: this is the turn you asked for. Carry on with what you planned, or reply [nothing].)
