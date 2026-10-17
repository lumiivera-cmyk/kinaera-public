# Reasoning

Thinking models reason before they answer. Kinaera keeps that reasoning so
you can read it.

## Where it comes from

`readReasoning` in `src/nanogpt.ts` takes it from the reply, wherever the
provider put it: `message.reasoning` (nanoGPT's default), `reasoning_content`
(nanoGPT's legacy endpoint and some providers), `reasoning_details` pieces, or
`<think>…</think>` text in the reply itself (still stripped from the post).
Models that don't reason, or providers that hide it, give nothing, and
nothing is stored.

## Where it's kept

The `reasoning` table (migration 15), one row per round of a kinwriter turn
that had any, keyed by the turn id the turn's messages carry, like tool
calls. Only kinwriter turns are kept: Jev, the summarizer and the generator
aren't.

## Where it shows

- Under the turn's messages: a folded "💭 Arlo's reasoning · N words" line
  above the tool activity line. Tapping it opens the text, round by round
  when the turn called tools between rounds. A turn that wrote nothing shows
  the line on its own, in time order.
- The developer panel (`DEVELOPER_PANEL=1`): the newest 50 rounds across
  every channel.
- Settings → Prompts → Dry run with Send: "Their reasoning" above the reply.

## What the kinwriter is told

`reasoning` in `defaults/standing.md`, in every turn's prompt: that their
reasoning is saved with the turn, that the user can open it under their
messages, and that it's in the developer panel.

## Turning it off

A profile's Reasoning setting is the model's default, Off, or Low / Medium /
High effort. Off sends `reasoning_effort: "none"`, which nanoGPT honours on
models that can answer without thinking; a model that always thinks refuses
it, and the error says so. (Migration 16 rebuilt `profiles` so its CHECK
rule allows `none`.)

## Only the settings a model supports

nanoGPT's `GET /models?detailed=true` says, per model, whether it reasons,
whether it calls tools natively, and its output limit (`listModels` in
`src/nanogpt.ts`; `/api/models` returns it as `info`). The profile editors
(`public/js/model-info.js`) use it to hide Reasoning for a model that can't
reason, cap Max tokens at the model's limit, and note when a model has no
native tool calling (it may still manage tools as text, so the checkbox
stays). nanoGPT says nothing about temperature, Top P or Min P, so those
always show, and a model the list doesn't know shows everything.
