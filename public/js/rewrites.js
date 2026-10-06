/**
 * Rewrites (src/rewrites.ts): highlight part of your kinwriter's message and
 * suggest new words for it. They accept or decline each one; accepting puts
 * your words in as their edit.
 *
 * Select text in one of their messages and "✎ Suggest" appears next to
 * "💬 Comment" (on a phone, just above the message box), or tap Suggest
 * under the message and trim it to the part you'd change. Waiting
 * suggestions are underlined in the message (tap one to withdraw it), and
 * a line under the message says how they answered.
 */

import { $, api, channelPath, hideFormError, showFormError, state } from "./core.js";

/** The rewrites on one message. */
export function rewritesOn(messageId) {
  return (state.rewrites ?? []).filter((r) => r.messageId === messageId && r.status !== "withdrawn");
}

/** Underline each waiting rewrite's words in a rendered message. */
export function highlightRewrites(content, rewrites) {
  for (const rewrite of rewrites.filter((r) => r.status === "pending")) {
    const quote = rewrite.quote.replace(/[*_]/g, "").trim();
    if (!quote) continue;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = "";
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: text.length });
      text += walker.currentNode.nodeValue;
    }
    const start = text.indexOf(quote);
    if (start < 0) continue;
    const end = start + quote.length;
    for (const { node, start: nodeStart } of nodes) {
      const nodeEnd = nodeStart + node.nodeValue.length;
      if (nodeEnd <= start || nodeStart >= end) continue;
      const range = document.createRange();
      range.setStart(node, Math.max(0, start - nodeStart));
      range.setEnd(node, Math.min(node.nodeValue.length, end - nodeStart));
      const mark = document.createElement("mark");
      mark.className = "rewrite-mark";
      mark.dataset.rewrite = rewrite.id;
      mark.title = `Your suggestion: “${rewrite.replacement}” (waiting for ${state.settings.friendName}; tap to withdraw)`;
      range.surroundContents(mark);
    }
  }
}

/** A line under the message: how they answered your suggestions. */
export function rewriteSummary(rewrites) {
  if (!rewrites.length) return null;
  const line = document.createElement("div");
  line.className = "message-rewrites";
  const count = (status) => rewrites.filter((r) => r.status === status).length;
  const parts = [
    count("pending") && `${count("pending")} waiting`,
    count("accepted") && `${count("accepted")} accepted`,
    count("declined") && `${count("declined")} declined`,
  ].filter(Boolean);
  line.textContent = `✎ Your suggestions: ${parts.join(", ")}`;
  const notes = rewrites.filter((r) => r.note).map((r) => `“${r.quote}”: ${r.note}`);
  if (notes.length) line.title = notes.join("\n");
  return line;
}

/** Show "✎ Suggest" beside "💬 Comment" when the selection is in one of their messages. */
export function updateRewriteButton(comment) {
  const button = $("rewrite-float");
  const id = comment.dataset.messageId;
  const message = id ? document.querySelector(`.message[data-message-id="${CSS.escape(id)}"]`) : null;
  if (!message || message.dataset.author !== "friend") {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.dataset.messageId = id;
  button.dataset.quote = comment.dataset.quote;
}

/**
 * Suggest new words: from selected text (the quote is what you selected),
 * or from "Suggest" under their message (the quote starts as the whole
 * message, for you to trim to the part you'd change).
 */
export function openRewrite(messageId, quote) {
  const form = $("rewrite-form");
  hideFormError(form);
  form.dataset.messageId = messageId;
  form.elements.quote.value = quote;
  form.elements.replacement.value = quote;
  $("rewrite-dialog").showModal();
  form.elements.replacement.focus();
}

$("rewrite-float").addEventListener("pointerdown", (event) => event.preventDefault());
$("rewrite-float").addEventListener("click", (event) => {
  const { messageId, quote } = event.currentTarget.dataset;
  $("selection-bar").hidden = true;
  document.getSelection()?.removeAllRanges();
  openRewrite(messageId, quote);
});

$("rewrite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const { rewrites } = await api("POST", `/api/messages/${encodeURIComponent(form.dataset.messageId)}/rewrites`, {
      quote: form.elements.quote.value,
      replacement: form.elements.replacement.value,
    });
    state.rewrites = rewrites;
    $("rewrite-dialog").close();
    const { renderMessages } = await import("./messages.js");
    renderMessages();
  } catch (error) {
    showFormError(form, error.message);
  }
});

/** Tap an underlined suggestion to withdraw it. */
export async function withdrawRewrite(id) {
  if (!confirm("Withdraw this suggestion?")) return;
  try {
    const { rewrites } = await api("POST", `/api/rewrites/${encodeURIComponent(id)}/withdraw`, {});
    state.rewrites = rewrites;
    const { renderMessages } = await import("./messages.js");
    renderMessages();
  } catch (error) {
    alert(error.message);
  }
}

/** Reload the open channel's rewrites (after their turn, say). */
export async function refreshRewrites() {
  const channelId = state.channelId;
  if (!channelId) return;
  const { rewrites } = await api("GET", channelPath("messages", channelId));
  if (state.channelId === channelId) state.rewrites = rewrites ?? [];
}
