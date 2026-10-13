/**
 * Branches: the conversation as a tree, NovelAI-style (src/store.ts,
 * `branchFrom`).
 *
 * - "Go back here" on a message sets aside everything after it as a branch.
 * - "⑂ 2" next to a message's time: the ways the conversation went on from
 *   it. Tap to see them and go to one; what's there now becomes a branch in
 *   turn, so nothing is lost.
 * - Regenerating an earlier reply goes back to it first, and an earlier
 *   version of a regenerated reply can be brought back from its history.
 *   The branches after a reply come and go with that reply.
 */

import { renderAll } from "./channels.js";
import { $, api, channelPath, hideFormError, showError, showFormError, state } from "./core.js";
import { formatText, formatTime } from "./format.js";

/** The branches that follow a message (not counting what follows it now). */
export function branchesAt(messageId) {
  return (state.branches ?? []).filter((b) => b.forkId === messageId);
}

/** Take in a channel's messages and branches after one of these changes. */
function accept(channelId, data) {
  if (state.channelId !== channelId) return;
  state.messages = data.messages;
  state.branches = data.branches;
  renderAll();
}

/** "Go back here": everything after the message becomes a branch. */
export async function goBack(message) {
  const after = state.messages.length - 1 - state.messages.findIndex((m) => m.id === message.id);
  if (!confirm(`Go back to this message? The ${after} message${after === 1 ? "" : "s"} after it are kept as a branch you can return to (⑂ next to its time).`)) return;
  const channelId = state.channelId;
  try {
    accept(channelId, await api("POST", `/api/messages/${encodeURIComponent(message.id)}/branch`, {}));
  } catch (error) {
    showError(error.message, null);
  }
}

/** Bring back an earlier version of a regenerated reply (from its history). */
export async function bringBack(messageId) {
  const channelId = state.channelId;
  accept(channelId, await api("POST", `/api/messages/${encodeURIComponent(messageId)}/use`, {}));
}

/** A branch, as a card: how it starts, how long it is, and a button to go there. */
function branchCard(heading, first, last, count, onGo) {
  const item = document.createElement("li");
  item.className = "history-version";
  if (!onGo) item.dataset.current = "";
  const head = document.createElement("div");
  head.className = "hint";
  head.textContent = heading;
  item.append(head);
  if (first) {
    const text = document.createElement("div");
    text.className = "history-version-text branch-preview";
    text.innerHTML = formatText(first.content);
    item.append(text);
  }
  if (count > 1 && last) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = `… ${count - 1} more, the last ${formatTime(last.createdAt)}`;
    item.append(more);
  }
  if (onGo) {
    const go = document.createElement("button");
    go.type = "button";
    go.className = "link-button";
    go.textContent = "Go to this branch";
    go.addEventListener("click", onGo);
    item.append(go);
  }
  return item;
}

/** The ways the conversation went on from a message: what's there now, and each branch. */
export function openBranches(forkId) {
  const dialog = $("branches-dialog");
  hideFormError(dialog);
  const channelId = state.channelId;
  const index = state.messages.findIndex((m) => m.id === forkId);
  const now = state.messages.slice(index + 1);
  const cards = [
    branchCard(now.length ? `Now: ${now.length} message${now.length === 1 ? "" : "s"}` : "Now: nothing after this yet", now[0], now.at(-1), now.length, null),
    ...branchesAt(forkId).map((b, i) =>
      branchCard(`Branch ${i + 1}: ${b.count} message${b.count === 1 ? "" : "s"}, from ${formatTime(b.first.createdAt)}`, b.first, b.last, b.count, async () => {
        try {
          accept(channelId, await api("POST", channelPath("branches/switch", channelId), { branchId: b.id }));
          dialog.close();
        } catch (error) {
          showFormError(dialog, error.message);
        }
      }),
    ),
  ];
  $("branches-list").replaceChildren(...cards);
  $("branches-note").textContent =
    `Where the conversation went from here. Going to a branch keeps what's there now as a branch too. ${state.settings.friendName} sees only the branch you're on.`;
  dialog.showModal();
}
