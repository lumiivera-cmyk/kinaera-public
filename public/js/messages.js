/**
 * Messages and turns: sending, your kinwriter's turn, regenerating, stopping,
 * editing and deleting, and drawing the conversation.
 *
 * Only one turn runs per channel at a time. While one is running, the
 * channel is "busy", and the app keeps an eye on it until it's done.
 */

import { renderAll } from "./channels.js";
import { highlightThreads, newComment, openThread, threadsOn } from "./comments.js";
import { highlightRewrites, openRewrite, rewritesOn, rewriteSummary } from "./rewrites.js";
import { autoGrow, renderAttachments } from "./composer.js";
import { $, api, channelPath, currentChannel, els, hideError, readLocal, showError, state, writeLocal } from "./core.js";
import { badge, formatText, formatTime, hueFor, initial, quietSummary } from "./format.js";
import { branchesAt, goBack, openBranches } from "./branches.js";
import { openHistory } from "./history.js";
import { checkForUpdate } from "./live.js";
import { refreshNotebook } from "./notebook.js";
import { openReactionPicker, renderReactions } from "./reactions.js";
import { assignmentName } from "./settings.js";
import { profileEditor, resolveAssignment, resolveProfileId } from "./profile-inline.js";
import { renderSceneSummary, toggleSceneSummary } from "./summaries.js";
import { finishReveal, revealLater, sendText } from "./texting.js";
import { isShared, paintPeer } from "./groups.js";
import { showNotice } from "./themes.js";

// ------------------------------------------------------ messages & turns

/**
 * Requests from *this* page that make the kinwriter write, by channel id.
 * Each is `{ startedAt, onAbandon }`; see `withBusyChannel` and `checkBusy`.
 */
const pendingRequests = new Map();

/**
 * Run a request that makes the kinwriter write in a channel: marks the channel
 * busy while it runs, and redraws afterwards.
 *
 * @param work       Does the request. It receives `stillMine()`, which turns
 *                   false if the request was abandoned (you pressed Stop, or
 *                   the page decided the request was lost). An abandoned
 *                   request's late answer must be ignored: the channel has
 *                   already been reloaded from the server.
 * @param onAbandon  Optional. Called with the reloaded messages if the
 *                   request is abandoned while you're in its channel.
 */
export async function withBusyChannel(channelId, work, onAbandon) {
  const request = { startedAt: Date.now(), onAbandon };
  pendingRequests.set(channelId, request);
  state.busy.add(channelId);
  renderAll();
  if (channelId === state.channelId) scrollToBottom();
  startBusyWatch();

  const stillMine = () => pendingRequests.get(channelId) === request;
  try {
    await work(stillMine);
  } finally {
    if (stillMine()) {
      pendingRequests.delete(channelId);
      state.busy.delete(channelId);
      renderAll();
      if (channelId === state.channelId) scrollToBottom();
    }
  }
}

/**
 * Stop waiting for this page's request in a channel. Returns the request
 * (or undefined if there wasn't one), so its `onAbandon` can still be run.
 */
function abandonRequest(channelId) {
  const request = pendingRequests.get(channelId);
  pendingRequests.delete(channelId);
  state.busy.delete(channelId);
  return request;
}

/**
 * Take in a channel's messages and what's shown with them (its tool calls,
 * reasoning, comment threads, rewrites, flags and branches), as
 * GET /api/channels/:id/messages sends them.
 */
export function acceptChannelData(data) {
  state.messages = data.messages;
  state.toolCalls = data.toolCalls ?? [];
  state.reasoning = data.reasoning ?? [];
  state.threads = data.threads ?? [];
  state.rewrites = data.rewrites ?? [];
  state.flags = data.flags ?? { voice: [], notMe: {} };
  state.branches = data.branches ?? [];
}

/** Reload the open channel's messages, e.g. after a turn was stopped. */
export async function refreshMessages(onAbandon) {
  const channelId = state.channelId;
  if (!channelId) return;
  try {
    const data = await api("GET", channelPath("messages", channelId));
    if (state.channelId !== channelId) return;
    acceptChannelData(data);
    onAbandon?.(data.messages);
  } catch (error) {
    showError(`Couldn't reload this channel: ${error.message}`, () => refreshMessages());
  }
  renderAll();
  scrollToBottom();
}

/**
 * The Stop button: ask the server to stop your kinwriter's turn in the open
 * channel, stop waiting for it here, and reload the channel so it shows
 * exactly what was saved (your message, if you'd just sent one; no reply).
 */
export async function stopTurn() {
  const channelId = state.channelId;
  const request = abandonRequest(channelId);
  hideError();
  renderAll();
  try {
    await api("POST", channelPath("cancel", channelId), {});
  } catch (error) {
    showError(`Couldn't reach the server to stop the reply: ${error.message}`, null);
  }
  await refreshMessages(request?.onAbandon);
}

/*
 * Checking in with the server while anything is busy.
 *
 * A request can be lost without ever failing: on a phone, the connection
 * can quietly drop when the app goes to the background or the screen locks,
 * and the page would wait for an answer that never comes, with the channel
 * stuck on "writing…". So while any channel is busy, the page asks the
 * server every few seconds which channels are *really* busy, and:
 *
 *   - a channel the server has finished with is un-stuck and reloaded, so
 *     the reply (or your saved message) appears
 *   - a channel the server is busy with, but this page didn't know about
 *     (a turn from another tab, or from before a reload), is marked busy
 */

/** How often to check, in milliseconds. */
const BUSY_CHECK_INTERVAL = 3000;
/**
 * A request younger than this is never treated as lost: it may simply not
 * have reached the server yet.
 */
const LOST_REQUEST_GRACE = 8000;

let busyWatch = null;

export function startBusyWatch() {
  if (!busyWatch) busyWatch = setInterval(checkBusy, BUSY_CHECK_INTERVAL);
}

async function checkBusy() {
  if (state.busy.size === 0) {
    clearInterval(busyWatch);
    busyWatch = null;
    return;
  }
  // Not while the app is in the background; it catches up when you come back.
  if (document.visibilityState !== "visible") return;

  let serverBusy;
  try {
    const data = await api("GET", "/api/state");
    serverBusy = new Set(data.busyChannels);
    state.phases = data.phases ?? {};
    state.presence = data.presence ?? state.presence;
    checkForUpdate(data.appVersion);
  } catch {
    return; // server unreachable for a moment; try again next time
  }

  for (const channelId of [...state.busy]) {
    if (serverBusy.has(channelId)) continue;
    const request = pendingRequests.get(channelId);
    if (request && Date.now() - request.startedAt < LOST_REQUEST_GRACE) continue;
    // The server is done, but this page never heard back. Catch up.
    abandonRequest(channelId);
    if (channelId === state.channelId) await refreshMessages(request?.onAbandon);
  }
  for (const channelId of serverBusy) state.busy.add(channelId);
  renderAll();
}

/**
 * Send what's in the text box. The server saves it and your kinwriter replies
 * in the same request.
 */
export async function sendMessage() {
  const channelId = state.channelId;
  const content = els.input.value;
  if (!channelId || content.trim() === "" || state.busy.has(channelId)) return;
  finishReveal();
  // Texting in OOC: each send is a bubble, and your kinwriter answers once you pause.
  const texting = currentChannel()?.kind === "ooc" && state.settings.oocBubbles && state.settings.replyDelayMs > 0;
  if (texting) return sendText(channelId, content);

  hideError();
  // Show your post straight away, as a placeholder, while the kinwriter
  // writes. It's swapped for the saved copy when the server answers.
  const channel = currentChannel();

  // `=====` (plus an optional title) on its own is a scene break, not a post.
  // (The server understands it too, but handling it here avoids showing
  // "=====" as a message for a moment.)
  const sceneTitle = channel.kind === "rp" ? content.trim().match(/^={5,}[ \t]*([^\n]*)$/) : null;
  if (sceneTitle) {
    els.input.value = "";
    state.drafts.delete(channelId);
    autoGrow();
    await addSceneBreak(sceneTitle[1].trim());
    return;
  }

  const postingAs = channel.kind === "rp" && channel.mode === "casual" ? state.postingAs.get(channelId) || null : null;
  // Notes attached with the paperclip go with this message, then are cleared.
  const attach = [...(state.attachments.get(channelId) ?? [])];
  state.attachments.delete(channelId);
  // A reply to an earlier message (the Reply button), then cleared.
  const replyTo = takeReply(channelId);
  const sentAt = new Date();
  const placeholder = {
    id: "pending",
    channelId,
    kind: "post",
    mode: channel.kind === "rp" ? channel.mode : null,
    author: "user",
    content,
    characters: postingAs ? [postingAs] : [],
    attachments: attach,
    ...(replyTo ? { replyTo } : {}),
    createdAt: sentAt.toISOString(),
  };
  state.messages.push(placeholder);
  els.input.value = "";
  state.drafts.delete(channelId);
  autoGrow();

  // If the request is abandoned (Stop, or lost) and the server never saved
  // your message, put your text back in the box so it isn't lost.
  const restoreIfUnsaved = (messages) => {
    // In casual mode your text may have been split into several bubbles, so
    // look for any post of yours from this send whose text is part of it.
    const saved = messages.some(
      (m) => m.author === "user" && new Date(m.createdAt) >= sentAt - 2000 && content.includes(m.content),
    );
    if (!saved && els.input.value === "") {
      els.input.value = content;
      autoGrow();
    }
  };

  await withBusyChannel(
    channelId,
    async (stillMine) => {
      try {
        const data = await api("POST", channelPath("messages", channelId), { content, postingAs, attach, replyTo });
        if (!stillMine()) return; // abandoned; the channel was already reloaded
        if (state.channelId !== channelId) return; // you've moved on; it'll load when you return
        // Posting as one of your characters adds them to the cast.
        if (data.channel) updateChannelInState(data.channel);
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.messages.push(...data.userMessages);
        if (data.kinwriterMessages) {
          acceptTurn(data);
        } else if (data.error) {
          // Your message is saved but the reply failed. "Try again" asks the
          // kinwriter for a turn, which answers the message you already sent.
          showError(data.error, kinwriterTurn);
        }
        // (If data.cancelled, the reply was stopped: your message stays, and
        // there's nothing more to show.)
      } catch (error) {
        if (!stillMine()) return;
        // Nothing was saved (e.g. the server is down), so put your text back
        // in the box; "Try again" simply sends it again.
        state.messages = state.messages.filter((m) => m !== placeholder);
        state.attachments.set(channelId, new Set(attach));
        if (state.channelId === channelId) {
          els.input.value = content;
          autoGrow();
          showError(error.message, sendMessage);
        } else {
          state.drafts.set(channelId, content);
        }
      }
    },
    restoreIfUnsaved,
  );
}

/** Let your kinwriter write without a new message from you. */
export async function kinwriterTurn() {
  await runTurn("turn", acceptTurn, kinwriterTurn);
}

/**
 * Replace your kinwriter's last reply (every bubble of it, in casual mode) with
 * a fresh one.
 *
 * @param profileId  Write with this profile. Without one, the channel's
 *                   profile or roulette picks again.
 * @param messageId  An earlier reply to regenerate instead: what came after
 *                   it is kept as a branch (js/branches.js).
 */
export async function regenerate(profileId, messageId) {
  if (messageId) {
    const after = state.messages.length - 1 - state.messages.findIndex((m) => m.id === messageId);
    if (!confirm(`Regenerate this reply? The ${after} message${after === 1 ? "" : "s"} after it are kept as a branch, which comes back with this version of the reply.`)) return;
  }
  await runTurn(
    "regenerate",
    (data) => {
      if (data.branched) {
        // Messages left the chat: reload it, with its branches.
        state.toolCalls.push(...(data.toolCalls ?? []));
        if (data.channels) state.channels = data.channels;
        refreshMessages().catch(() => {});
        return;
      }
      const replaced = new Set(data.replacedIds);
      state.messages = state.messages.filter((m) => !replaced.has(m.id));
      acceptTurn(data);
    },
    () => regenerate(profileId, messageId),
    { ...(profileId ? { profileId } : {}), ...(messageId ? { messageId } : {}) },
  );
}

/**
 * Add a scene break to the open channel. If a mode change was waiting, the
 * server applies it now, and sends the updated channel back.
 */
async function addSceneBreak(title) {
  const channelId = state.channelId;
  hideError();
  try {
    const data = await api("POST", channelPath("scene-breaks", channelId), { title });
    updateChannelInState(data.channel);
    if (state.channelId !== channelId) return;
    state.messages.push(data.sceneBreak);
    renderAll();
    scrollToBottom();
  } catch (error) {
    showError(error.message, null);
  }
}

/** The "New scene" button: ask for an optional title, then add the break. */
export function newScene() {
  const title = prompt("Title for the new scene (optional):", "");
  if (title !== null) addSceneBreak(title.trim());
}

async function renameSceneBreak(sceneBreak) {
  const title = prompt("Scene title:", sceneBreak.content);
  if (title === null) return;
  try {
    const data = await api("PATCH", `/api/messages/${encodeURIComponent(sceneBreak.id)}`, { content: title.trim() });
    state.messages = state.messages.map((m) => (m.id === sceneBreak.id ? data.message : m));
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

/**
 * Take in a kinwriter turn's result: its messages, the tools it called, and
 * any change those made to the channels. If it acted, the notebook and
 * inbox may have changed too, so they're reloaded.
 */
function acceptTurn(data) {
  // Texts in OOC come in one at a time, with "typing…" between them.
  const channel = currentChannel();
  if (channel?.kind === "ooc" && state.settings.oocBubbles && data.kinwriterMessages.length > 1) {
    const [first, ...rest] = data.kinwriterMessages;
    state.messages.push(first);
    revealLater(channel.id, rest);
  } else {
    state.messages.push(...data.kinwriterMessages);
  }
  state.toolCalls.push(...(data.toolCalls ?? []));
  state.reasoning.push(...(data.reasoning ?? []));
  if (data.channels) state.channels = data.channels;
  const skippedNotice = `${state.settings.kinwriterName} chose not to reply this time.`;
  if (data.skipped && data.kinwriterMessages.length === 0) {
    showNotice(skippedNotice);
  } else if ($("notice-text").textContent === skippedNotice) {
    $("notice").hidden = true;
  }
  if (data.toolCalls?.length) {
    refreshNotebook().catch(() => {});
    // Your kinwriter may have commented on messages, or marked, flagged, or
    // posted something here mid-turn (a draft): reload the channel.
    const reload = ["mark_my_voice", "flag_not_me", "post_draft"];
    if (data.toolCalls.some((c) => c.name.includes("comment") || reload.includes(c.name))) refreshMessages();
  }
}

/** Replace a channel in `state.channels` with a fresh copy from the server. */
export function updateChannelInState(channel) {
  state.channels = state.channels.map((c) => (c.id === channel.id ? channel : c));
}

/**
 * Shared wrapper for kinwriter turns in the open channel.
 *
 * @param action     "turn" or "regenerate" (the end of the API path).
 * @param onSuccess  Updates `state.messages` with the server's answer. Not
 *                   called if the turn was stopped.
 * @param retry      What "Try again" should do if it fails.
 * @param body       Sent with the request (e.g. the profile to regenerate with).
 */
async function runTurn(action, onSuccess, retry, body = {}) {
  const channelId = state.channelId;
  if (!channelId || state.busy.has(channelId)) return;
  hideError();
  await withBusyChannel(channelId, async (stillMine) => {
    try {
      const data = await api("POST", channelPath(action, channelId), body);
      if (stillMine() && state.channelId === channelId && data.kinwriterMessages) onSuccess(data);
    } catch (error) {
      if (stillMine() && state.channelId === channelId) showError(error.message, retry);
    }
  });
}

async function saveEdit(id, content) {
  try {
    const data = await api("PATCH", `/api/messages/${encodeURIComponent(id)}`, { content });
    state.messages = state.messages.map((m) => (m.id === id ? data.message : m));
    state.editingId = null;
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

async function deleteMessage(id) {
  if (!confirm("Delete this message?")) return;
  try {
    await api("DELETE", `/api/messages/${encodeURIComponent(id)}`, {});
    // Branches after it move to the message before: reload to show them there.
    if (branchesAt(id).length > 0) return refreshMessages();
    state.messages = state.messages.filter((m) => m.id !== id);
    renderMessages();
  } catch (error) {
    showError(error.message, null);
  }
}

/**
 * Whether the open channel's current scene has no posts yet (nothing since
 * the last scene break). A mode change applies at once in that case, and at
 * the next scene break otherwise; the server decides, this is just for the
 * hint in channel settings.
 */
export function currentSceneIsEmpty() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].kind === "scene_break") return true;
    if (state.messages[i].id !== "pending") return false;
  }
  return true;
}

/*
 * Redrawing the message list rebuilds it from `state`, which would wipe
 * two things you might be in the middle of: what you're typing in an edit
 * box (kept, with the cursor), and text you've selected to comment on or
 * suggest new words for (the redraw waits until the selection is gone).
 */

/** A redraw was skipped while you had text selected. */
let redrawWhenUnselected = false;

/** Whether you've selected text in the message list (not in an edit box, which keeps its own). */
function selectingInMessages() {
  if (document.activeElement?.matches?.("textarea, input")) return false;
  const selection = document.getSelection();
  return Boolean(selection && !selection.isCollapsed && els.messages.contains(selection.anchorNode));
}

document.addEventListener("selectionchange", () => {
  if (redrawWhenUnselected && !selectingInMessages()) renderMessages();
});

/** Redraw the message list from `state.messages`. */
export function renderMessages() {
  if (selectingInMessages()) {
    redrawWhenUnselected = true;
    return;
  }
  redrawWhenUnselected = false;
  // Edit boxes (marked `data-draft`): what's typed in them, and where the cursor is.
  const drafts = new Map();
  for (const box of els.messages.querySelectorAll("textarea[data-draft]")) {
    drafts.set(box.dataset.draft, { value: box.value, start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box });
  }
  drawMessages();
  for (const box of els.messages.querySelectorAll("textarea[data-draft]")) {
    const draft = drafts.get(box.dataset.draft);
    // Just opened: ready to type in.
    if (!draft) {
      box.focus();
      continue;
    }
    box.value = draft.value;
    if (draft.focused) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(draft.start, draft.end);
    }
  }
}

function drawMessages() {
  const channel = currentChannel();
  els.messages.replaceChildren();

  if (!channel) {
    els.messages.append(
      emptyNote("There are no channels yet. Create one with the + button at the top of the channel list."),
    );
    return;
  }

  // Tool calls grouped by turn. Turns that wrote messages show their actions
  // under them; turns that only acted are shown on their own, in time order.
  const turns = toolCallsByTurn();
  const thoughts = reasoningByTurn();
  const turnsWithMessages = new Set(state.messages.map((m) => m.turnId).filter(Boolean));
  // Turns that wrote nothing, with what they did or thought, oldest first.
  const loose = [...new Set([...turns.keys(), ...thoughts.keys()])]
    .filter((turnId) => !turnsWithMessages.has(turnId))
    .map((turnId) => [turnId, (thoughts.get(turnId) ?? turns.get(turnId))[0].createdAt])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // What a turn did and thought, under its messages (or on its own).
  const afterTurn = (turnId) => {
    const parts = [];
    if (thoughts.has(turnId)) parts.push(renderReasoning(turnId, thoughts.get(turnId)));
    if (turns.has(turnId)) parts.push(renderActivity(turnId, turns.get(turnId)));
    return parts;
  };

  // Branches from the very start of the chat (their first message was deleted).
  const fromStart = branchesAt("start").length;
  if (fromStart > 0) {
    const tree = document.createElement("button");
    tree.type = "button";
    tree.className = "message-history branches-from-start";
    tree.textContent = `⑂ ${fromStart + 1} from the start`;
    tree.title = `${fromStart} other ${fromStart === 1 ? "branch" : "branches"} from the start of the chat. Tap to see them.`;
    tree.addEventListener("click", () => openBranches("start"));
    els.messages.append(tree);
  }

  if (state.messages.length === 0 && loose.length === 0) {
    els.messages.append(
      emptyNote(
        channel.kind === "ooc"
          ? `Nothing here yet. Say hi, or press “${state.settings.kinwriterName}'s turn” to let them start the conversation.`
          : `No messages yet. Write the first post, or press “${state.settings.kinwriterName}'s turn” to let them open the story.`,
      ),
    );
    return;
  }

  // The last kinwriter turn can be regenerated. In casual mode that's every
  // bubble of the last reply; the button goes on the last one.
  const last = state.messages.at(-1);
  // Not in a group channel or DM: the others have already seen it.
  const canBranch = !isShared(currentChannel());
  const canRegenerate = last?.kind === "post" && last.author === "kinwriter" && canBranch;

  // A run of turns that wrote nothing, in a row: one line each, or folded
  // into a single line when there are enough of them to bury the chat.
  const appendQuiet = (run) => {
    if (run.length >= FOLD_QUIET_AT && foldQuietOn()) els.messages.append(renderQuietRun(run, turns, afterTurn));
    else for (const turnId of run) els.messages.append(...afterTurn(turnId));
  };

  let previous = null;
  state.messages.forEach((message, index) => {
    // Actions from turns that wrote nothing, before this message.
    const run = [];
    while (loose.length && loose[0][1] <= message.createdAt) run.push(loose.shift()[0]);
    if (run.length) {
      appendQuiet(run);
      previous = null;
    }
    const element =
      message.kind === "scene_break"
        ? renderSceneBreak(message)
        : renderMessage(message, {
            continued: continuesGroup(previous, message),
            regenerate: canRegenerate && message === last,
            // Earlier messages: go back to them, or regenerate an earlier reply (the
            // last bubble of it), keeping what came after as a branch.
            branch: canBranch && message !== last,
            regenerateEarlier:
              canBranch && message !== last && message.author === "kinwriter" && (!message.turnId || state.messages[index + 1]?.turnId !== message.turnId),
          });
    els.messages.append(element);
    previous = message;
    // After a turn's last message, the actions it took.
    const next = state.messages[index + 1];
    if (message.turnId && next?.turnId !== message.turnId) els.messages.append(...afterTurn(message.turnId));
  });
  if (loose.length) appendQuiet(loose.map(([turnId]) => turnId));
}

/** How many quiet turns in a row get folded into one line. */
const FOLD_QUIET_AT = 3;
const FOLD_QUIET_KEY = "kinaera.foldQuiet"; // "0" turns folding off on this device

/** Whether runs of quiet turns are folded on this device (on unless turned off in Appearance). */
export function foldQuietOn() {
  return readLocal(FOLD_QUIET_KEY) !== "0";
}

export function setFoldQuiet(on) {
  writeLocal(FOLD_QUIET_KEY, on ? null : "0");
  renderMessages();
}

/**
 * Several turns in a row that wrote nothing (checked in, chose not to
 * reply, read the channel): one line that opens into each turn's own line.
 * The run is remembered by its first turn, so it stays open as more arrive.
 */
function renderQuietRun(run, turns, afterTurn) {
  const root = document.createElement("div");
  root.className = "activity quiet-run";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-summary";
  const key = run[0];
  const open = state.openQuiet.has(key);
  toggle.setAttribute("aria-expanded", String(open));
  const summary = quietSummary(run.map((turnId) => turns.get(turnId) ?? []));
  if (summary.includes(" error")) root.classList.add("has-errors");
  toggle.textContent = `${open ? "▾" : "▸"} ⚙ ${state.settings.kinwriterName} · ${summary}`;
  toggle.addEventListener("click", () => {
    if (state.openQuiet.has(key)) state.openQuiet.delete(key);
    else state.openQuiet.add(key);
    renderMessages();
  });
  root.append(toggle);
  if (!open) return root;
  const fragment = document.createDocumentFragment();
  fragment.append(root);
  for (const turnId of run) fragment.append(...afterTurn(turnId));
  return fragment;
}

/**
 * Whether a message continues the one before it, Discord-style: same
 * author, same character(s), same mode, within a few minutes. A continued
 * message hides its avatar and name, so a burst of casual bubbles reads as
 * one block. Literary posts are always shown in full.
 */
function continuesGroup(previous, message) {
  if (!previous || previous.kind !== "post" || message.mode === "literary") return false;
  const sameVoice =
    previous.author === message.author &&
    // Two other kinwriters in a row are two people.
    previous.speaker?.id === message.speaker?.id &&
    previous.mode === message.mode &&
    previous.characters.join("|") === message.characters.join("|");
  const minutesApart = (new Date(message.createdAt) - new Date(previous.createdAt)) / 60000;
  return sameVoice && minutesApart < 7;
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty";
  note.textContent = text;
  return note;
}

/**
 * A scene break: a divider with the scene's title, and small buttons to
 * rename or remove it, and to show the summary of the scene it ended.
 */
function renderSceneBreak(sceneBreak) {
  const root = document.createElement("div");
  root.className = "scene-break";
  root.setAttribute("role", "separator");

  const title = document.createElement("span");
  title.className = "scene-break-title";
  title.textContent = sceneBreak.content || "New scene";
  root.append(title);

  const actions = document.createElement("span");
  actions.className = "scene-break-actions";
  const summaryButton = actionButton("Summary", () => toggleSceneSummary(sceneBreak.id));
  summaryButton.title = "What happened in the scene that ended here";
  summaryButton.setAttribute("aria-expanded", String(state.openSummaries.has(sceneBreak.id)));
  actions.append(
    summaryButton,
    actionButton("Rename", () => renameSceneBreak(sceneBreak)),
    actionButton("Remove", () => deleteMessage(sceneBreak.id), state.busy.has(state.channelId)),
  );
  root.append(actions);
  if (state.openSummaries.has(sceneBreak.id)) root.append(renderSceneSummary(sceneBreak));
  return root;
}

// ------------------------------------------------------------------ replies

/** Reply to a message: shown above where you write until you send (or ✕). */
function startReply(message) {
  state.replyingTo = { channelId: state.channelId, messageId: message.id };
  renderReplyBar();
  els.input.focus();
}

/** The reply waiting to go with your next message in this channel, cleared once taken. */
export function takeReply(channelId) {
  const reply = state.replyingTo?.channelId === channelId ? state.replyingTo.messageId : null;
  state.replyingTo = null;
  renderReplyBar();
  return reply;
}

/** "Replying to Arlo: …" above the box you write in. */
function renderReplyBar() {
  const bar = $("reply-bar");
  const reply = state.replyingTo?.channelId === state.channelId ? state.messages.find((m) => m.id === state.replyingTo.messageId) : null;
  bar.hidden = !reply;
  if (!reply) return;
  $("reply-bar-text").textContent = `Replying to ${authorOf(reply).name}: ${reply.content.replace(/\s+/g, " ").slice(0, 80)}`;
}

/** The quoted preview on a reply; tapping it jumps to the original. */
function renderReplyPreview(message) {
  const target = state.messages.find((m) => m.id === message.replyTo);
  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "message-reply-preview";
  preview.textContent = target
    ? `↪ ${authorOf(target).name}: ${target.content.replace(/\s+/g, " ").slice(0, 90)}`
    : "↪ a message that's no longer here";
  if (target) {
    preview.addEventListener("click", () => {
      const element = document.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("flash");
      setTimeout(() => element.classList.remove("flash"), 1500);
    });
  }
  return preview;
}

/**
 * Who a message shows as written by.
 *
 *   - Your posts: "You", or in casual mode the character you posted as,
 *     with "You" as a small badge.
 *   - Kinwriter posts that voice characters: the character names, with the
 *     kinwriter's name as a badge (it's them writing the character).
 *   - Kinwriter posts voicing no one (OOC): the kinwriter's name.
 */
function authorOf(message) {
  const writer = message.author === "user" ? "You" : message.author === "peer" ? (message.speaker?.name ?? "A kinwriter") : state.settings.kinwriterName;
  if (message.characters.length > 0) return { name: message.characters.join(" & "), badge: writer };
  return { name: writer, badge: null };
}

/**
 * Build the element for one message.
 *
 * The layout depends on the mode it was written in (`data-mode`), styled in
 * style.css:
 *
 *   - `literary`: a wide prose block with a small byline.
 *   - `casual`: a chat bubble with the character's avatar and name; a run of
 *     bubbles from the same character is grouped (`continued`).
 *   - `ooc`: like casual, for out-of-character channels.
 *
 * Text is always inserted as text, never as raw HTML, except for the tiny
 * bit of formatting in `formatText`, which escapes everything first. That
 * way a model reply containing `<script>` can't run code in your browser.
 *
 * @param options.continued   Hide the avatar and name (see `continuesGroup`).
 * @param options.regenerate  Show the Regenerate button.
 * @param options.branch      Show "Go back here" (js/branches.js).
 * @param options.regenerateEarlier  Show Regenerate for an earlier reply.
 */
function renderMessage(message, { continued = false, regenerate: showRegenerate = false, branch = false, regenerateEarlier = false } = {}) {
  const { name, badge } = authorOf(message);
  const pending = message.id === "pending";
  const mode = message.mode ?? "ooc";

  const root = document.createElement("article");
  root.className = ["message", pending && "pending", continued && "continued"].filter(Boolean).join(" ");
  root.dataset.author = message.author;
  root.dataset.mode = mode;
  root.dataset.messageId = message.id;
  // Tapping a casual bubble shows its Edit/Delete buttons (see style.css).
  if (mode === "casual") root.addEventListener("click", () => root.classList.toggle("selected"));

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initial(name);
  avatar.setAttribute("aria-hidden", "true");
  // Each character gets their own colour for avatar and name, like
  // Tupperbox. The hue is set on the whole message; style.css uses it.
  if (message.characters.length > 0) {
    root.classList.add("has-character");
    root.style.setProperty("--avatar-hue", String(hueFor(name)));
  } else if (message.author === "peer") {
    // Another kinwriter (a group channel or DM): their face and colour.
    paintPeer(avatar, root, message);
  } else if (message.author === "kinwriter") {
    // Your kinwriter as themselves: their avatar and colour (the Kinwriter menu).
    if (state.settings.kinwriterAvatar) avatar.textContent = state.settings.kinwriterAvatar;
    if (state.settings.kinwriterColor >= 0) {
      root.classList.add("has-character");
      root.style.setProperty("--avatar-hue", String(state.settings.kinwriterColor));
    }
  }

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  author.textContent = name;
  meta.append(author);
  if (badge) {
    const tag = document.createElement("span");
    tag.className = "message-badge";
    tag.textContent = badge;
    tag.title = `Written by ${badge}`;
    meta.append(tag);
  }
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = message.createdAt;
  time.textContent = formatTime(message.createdAt);
  meta.append(time);
  // Edited, or a regenerated reply: tap for its history (js/history.js).
  if (message.editedAt || message.alternates > 0) {
    const history = document.createElement("button");
    history.type = "button";
    history.className = "message-history";
    const parts = [];
    if (message.editedAt) parts.push("(edited)");
    if (message.alternates > 0) parts.push(`↻ ${message.alternates + 1}`);
    history.textContent = parts.join(" ");
    history.title = message.alternates > 0 ? `Regenerated: ${message.alternates} earlier ${message.alternates === 1 ? "reply" : "replies"} kept. Tap for history.` : "Tap for its history";
    history.addEventListener("click", () => openHistory(message.id));
    meta.append(history);
  }
  // Branches: other ways the conversation went on from here.
  const forks = branchesAt(message.id).length;
  if (forks > 0) {
    const tree = document.createElement("button");
    tree.type = "button";
    tree.className = "message-history";
    tree.textContent = `⑂ ${forks + 1}`;
    tree.title = `${forks} other ${forks === 1 ? "branch" : "branches"} from here. Tap to see them.`;
    tree.addEventListener("click", () => openBranches(message.id));
    meta.append(tree);
  }
  if (message.model) {
    const model = document.createElement("span");
    model.className = "message-model";
    // The profile's name if it has one, otherwise just the part of the model
    // id after the last "/" (e.g. "DeepSeek-V3.1-Terminus"), to save space on
    // a phone. The full model id appears when you hover or long-press.
    model.textContent = message.profile ?? message.model.split("/").at(-1);
    model.title = message.model;
    meta.append(model);
  }

  root.append(avatar, meta);

  if (state.editingId === message.id) {
    root.append(renderEditor(message));
    return root;
  }

  if (message.replyTo) root.append(renderReplyPreview(message));
  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = formatText(message.content);
  const threads = threadsOn(message.id);
  highlightThreads(content, threads);
  // Your suggested rewrites (js/rewrites.js): waiting ones underlined.
  const rewrites = rewritesOn(message.id);
  highlightRewrites(content, rewrites);
  // Marked by your kinwriter as sounding like them (mark_my_voice): a small ♪ at
  // the end of the text, so it shows on continued messages too.
  if (state.flags?.voice?.includes(message.id)) {
    const voice = document.createElement("span");
    voice.className = "message-voice";
    voice.textContent = " ♪";
    voice.title = `${state.settings.kinwriterName} marked this as sounding like them`;
    content.append(voice);
  }
  root.append(content);
  // Your kinwriter's own word on this post: it didn't sound like them (flag_not_me).
  const notMe = state.flags?.notMe?.[message.id];
  if (notMe) {
    const flag = document.createElement("p");
    flag.className = "message-flag";
    flag.textContent = `🚩 ${state.settings.kinwriterName}: this doesn't sound like me. “${notMe.note}”${notMe.profile ? ` (written by ${notMe.profile})` : ""}`;
    root.append(flag);
  }
  if (message.attachments?.length) root.append(renderAttachments(message));
  if (message.reactions?.length && !pending) root.append(renderReactions(message));

  // A post that's still being sent has no actions yet.
  if (pending) return root;

  // Comments on this message: a chip that opens them (open ones counted).
  if (threads.length) {
    const open = threads.filter((t) => !t.resolved).length;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "message-comments";
    chip.textContent = open ? `💬 ${open}` : "💬 ✓";
    chip.title = open ? `${open} open comment thread${open === 1 ? "" : "s"}` : "Resolved comments";
    chip.addEventListener("click", () => openThread((threads.find((t) => !t.resolved) ?? threads[0]).id));
    root.append(chip);
  }

  // Your suggested rewrites: how they answered.
  const rewriteLine = rewriteSummary(rewrites);
  if (rewriteLine) root.append(rewriteLine);

  const busy = state.busy.has(state.channelId);
  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (showRegenerate) actions.classList.add("always");
  actions.append(
    actionButton("Edit", () => {
      state.editingId = message.id;
      renderMessages();
    }),
    actionButton("Delete", () => deleteMessage(message.id), busy),
    actionButton("Reply", () => startReply(message)),
    actionButton("Comment", () => newComment(message.id)),
    // Their messages: suggest new words for part of it (js/rewrites.js).
    ...(message.author === "kinwriter" ? [actionButton("Suggest", () => openRewrite(message.id, message.content))] : []),
    actionButton("React", (event) => openReactionPicker(message.id, event.currentTarget)),
  );
  if (showRegenerate) {
    actions.append(actionButton("Regenerate", () => regenerate(), busy));
    if (state.profiles.length > 1) actions.append(actionButton("Regenerate with…", openRegenerateWith, busy));
  }
  if (regenerateEarlier) actions.append(actionButton("Regenerate", () => regenerate(undefined, message.id), busy));
  if (branch) actions.append(actionButton("Go back here", () => goBack(message), busy));
  root.append(actions);
  return root;
}

/** The inline editor shown in place of a message's text while editing. */
function renderEditor(message) {
  const wrapper = document.createElement("div");
  const box = document.createElement("textarea");
  box.className = "edit-box";
  box.value = message.content;
  // Kept through redraws (see `renderMessages`).
  box.dataset.draft = `message:${message.id}`;

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.append(
    actionButton("Save", () => {
      if (box.value.trim() !== "") saveEdit(message.id, box.value);
    }),
    actionButton("Cancel", () => {
      state.editingId = null;
      renderMessages();
    }),
  );

  wrapper.append(box, actions);
  return wrapper;
}

export function actionButton(label, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

export function scrollToBottom() {
  // Not while you've text selected further up (its redraw is waiting too).
  if (redrawWhenUnselected) return;
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** Whether the list is scrolled to the newest message, as of its last scroll. */
let atBottom = true;
els.messages.addEventListener(
  "scroll",
  () => (atBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 24),
  { passive: true },
);
// The on-screen keyboard (or turning the phone) changes the list's height:
// if you were at the newest message, stay there.
new ResizeObserver(() => atBottom && scrollToBottom()).observe(els.messages);

// ---------------------------------------------------- regenerate with...

/** "Regenerate with...": choose a profile, or let the channel's pick again. */
function openRegenerateWith() {
  const select = $("regenerate-profile");
  select.replaceChildren(
    new Option(`Pick again (${assignmentName(channelAssignment(currentChannel()))})`, ""),
    ...state.profiles.map((p) => new Option(p.name, p.id)),
  );
  // The chosen profile's settings, editable here ("Pick again": the channel's own).
  profileEditor(select, (id) => resolveProfileId(id, () => resolveAssignment(channelAssignment(currentChannel()))));
  $("regenerate-dialog").showModal();
}

/** The assignment that writes in a channel: its own, or the one in Settings for its kind. */
function channelAssignment(channel) {
  if (channel.assignment) return channel.assignment;
  return channel.kind === "ooc" ? state.settings.oocAssignment : state.settings.rpAssignment;
}

// ------------------------------------------------ your kinwriter's actions

/*
 * Your kinwriter acts through tools. Each turn's tool calls are
 * shown under the messages it wrote, as one line ("Arlo read Ilse Marrow,
 * pinned Tamsin to #story") that opens into the details: every call, its
 * arguments exactly as the model wrote them, and what it was told back.
 * A turn that only acted, and wrote nothing, shows the line on its own.
 */

/** The open channel's tool calls, grouped by turn: Map of turnId → calls. */
function toolCallsByTurn() {
  const turns = new Map();
  for (const call of state.toolCalls) {
    if (!turns.has(call.turnId)) turns.set(call.turnId, []);
    turns.get(call.turnId).push(call);
  }
  return turns;
}

/** The open channel's reasoning, grouped by turn: Map of turnId → rounds. */
function reasoningByTurn() {
  const turns = new Map();
  for (const entry of state.reasoning) {
    if (!turns.has(entry.turnId)) turns.set(entry.turnId, []);
    turns.get(entry.turnId).push(entry);
  }
  return turns;
}

/**
 * A thinking model's reasoning for one turn: a folded line that opens into
 * what it thought, round by round (rounds come between tool calls).
 */
function renderReasoning(turnId, rounds) {
  const root = document.createElement("div");
  root.className = "activity reasoning";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-summary";
  const open = state.openReasoning.has(turnId);
  toggle.setAttribute("aria-expanded", String(open));
  const words = rounds.reduce((n, r) => n + r.text.split(/\s+/).filter(Boolean).length, 0);
  toggle.textContent = `💭 ${state.settings.kinwriterName}'s reasoning · ${words} word${words === 1 ? "" : "s"}`;
  toggle.addEventListener("click", () => {
    if (state.openReasoning.has(turnId)) state.openReasoning.delete(turnId);
    else state.openReasoning.add(turnId);
    renderMessages();
  });
  root.append(toggle);
  if (open) {
    const list = document.createElement("div");
    list.className = "reasoning-details";
    for (const entry of rounds) {
      if (rounds.length > 1 || entry.round > 0) {
        const head = document.createElement("p");
        head.className = "reasoning-round";
        head.textContent = `Round ${entry.round + 1}${entry.model ? ` · ${entry.model}` : ""}`;
        list.append(head);
      }
      const text = document.createElement("pre");
      text.className = "reasoning-text";
      text.textContent = entry.text;
      list.append(text);
    }
    root.append(list);
  }
  return root;
}

/** One turn's actions: a summary line that opens into the details. */
function renderActivity(turnId, calls) {
  const root = document.createElement("div");
  root.className = "activity";
  const errors = calls.filter((c) => c.status === "error").length;
  if (errors) root.classList.add("has-errors");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "activity-summary";
  const open = state.openActivity.has(turnId);
  toggle.setAttribute("aria-expanded", String(open));
  // Only the actions that did something, once each ("read X" twice is noise).
  const done = [...new Set(calls.filter((c) => c.status === "ok").map((c) => c.summary))];
  const text = done.length ? `${state.settings.kinwriterName} ${done.join(", ")}` : `${state.settings.kinwriterName} tried to act`;
  toggle.textContent = `⚙ ${text}${errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}`;
  toggle.addEventListener("click", () => {
    if (state.openActivity.has(turnId)) state.openActivity.delete(turnId);
    else state.openActivity.add(turnId);
    renderMessages();
  });
  root.append(toggle);

  // Jev reminded them, and they posted without doing it: always shown, in Jev's words, not a verdict.
  for (const call of calls.filter((c) => c.name === "reflex")) {
    let settled = null;
    try {
      settled = JSON.parse(call.result);
    } catch {
      continue;
    }
    if (!settled?.flagged?.length) continue;
    const flag = document.createElement("p");
    flag.className = "activity-flag";
    const why = typeof settled.kept === "string" ? ` They said: “${settled.kept}”` : "";
    flag.textContent = `⚠ Jev read this as ${state.settings.kinwriterName} saying they'd ${settled.flagged.join(", and ")}. They were reminded, and posted it without doing it.${why}`;
    root.append(flag);
  }

  if (open) {
    const list = document.createElement("ol");
    list.className = "activity-details";
    list.append(...calls.map(renderToolCall));
    root.append(list);
  }
  return root;
}

/** One tool call, in full: for the activity details and the tool log. */
export function renderToolCall(call) {
  const item = document.createElement("li");
  item.className = "tool-call";
  item.dataset.status = call.status;
  item.dataset.source = call.source;

  const head = document.createElement("div");
  head.className = "tool-call-head";
  const name = document.createElement("code");
  name.className = "tool-call-name";
  name.textContent = call.name;
  head.append(name, badge(call.status === "ok" ? "ok" : "error"));
  if (call.source === "text") head.append(badge("written as text"));
  head.append(badge(`round ${call.round + 1}`));
  if (call.profile) head.append(badge(call.profile));
  const time = document.createElement("time");
  time.className = "message-time";
  time.dateTime = call.createdAt;
  time.textContent = formatTime(call.createdAt);
  head.append(time);

  const summary = document.createElement("p");
  summary.className = "tool-call-summary";
  summary.textContent = call.summary;

  const details = document.createElement("details");
  details.className = "tool-call-raw";
  const label = document.createElement("summary");
  label.textContent = "Arguments and result";
  const args = document.createElement("pre");
  args.textContent = prettyJson(call.arguments);
  const result = document.createElement("pre");
  result.textContent = prettyJson(call.result);
  details.append(label, args, result);

  item.append(head, summary, details);
  return item;
}

/** JSON text, indented if it parses, as-is if it doesn't (broken arguments stay visible). */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text || "(empty)";
  }
}
