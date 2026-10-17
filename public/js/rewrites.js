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

import { $, api, hideFormError, showError, showFormError, state } from "./core.js";
import { markQuote } from "./format.js";

/** The rewrites on one message. */
export function rewritesOn(messageId) {
  return (state.rewrites ?? []).filter((r) => r.messageId === messageId && r.status !== "withdrawn");
}

/** Underline each waiting rewrite's words in a rendered message. */
export function highlightRewrites(content, rewrites) {
  for (const rewrite of rewrites.filter((r) => r.status === "pending")) {
    const mark = () => {
      const element = document.createElement("mark");
      element.className = "rewrite-mark";
      element.dataset.rewrite = rewrite.id;
      element.title = `Your suggestion: “${rewrite.replacement}” (waiting for ${state.settings.kinwriterName}; tap to withdraw)`;
      return element;
    };
    markQuote(content, rewrite.quote, mark);
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
  if (!message || message.dataset.author !== "kinwriter") {
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
    showError(`Couldn't withdraw it: ${error.message}`, null);
  }
}
