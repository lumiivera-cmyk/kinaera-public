/**
 * Turning text into what's shown: escaping, *formatting*, custom emojis,
 * marking quoted text, initials, times, colours and badges.
 *
 * Everything shown from a message goes through `escapeHtml` first, and
 * only then gets its formatting, so nothing a model writes can become
 * working HTML.
 */

import { scoped, state } from "./core.js";

/** A stable hue (0-359) for a name, so each character keeps their colour. */
export function hueFor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

/**
 * Turn message text into safe HTML with light RP formatting:
 * `***bold italics***`, `**bold**` and `*italics*` (or `_italics_`), the
 * usual way of writing actions in roleplay. Line breaks are kept by CSS
 * (`white-space: pre-wrap`).
 *
 * `***` is handled first: otherwise `**` would take two of its asterisks,
 * and the tags would come out crossed (`<strong><em>…</strong></em>`).
 */
export function formatText(text) {
  return withCustomEmojis(
    escapeHtml(text)
      .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/(^|\W)_(.+?)_(?=\W|$)/g, "$1<em>$2</em>"),
  ).replace(/(^|[\s(])#([a-z0-9][a-z0-9-]{0,99})/g, (whole, before, name) => {
    // #channel: a chip that opens it (only for channels that exist here).
    const channel = state.channels?.find((c) => c.name === name);
    return channel ? `${before}<button type="button" class="channel-chip" data-channel-id="${channel.id}">#${name}</button>` : whole;
  });
}

/** Show `:name:` of a custom emoji as its image (in HTML that's already safe). */
function withCustomEmojis(html) {
  if (!state.emojis?.length) return html;
  const byName = new Map(state.emojis.map((e) => [e.name, e]));
  return html.replace(/:([a-z0-9_]{2,32}):/g, (whole, name) => {
    const emoji = byName.get(name);
    return emoji ? `<img class="custom-emoji" src="${scoped(`/emojis/${emoji.file}`)}" alt=":${name}:" title=":${name}:" />` : whole;
  });
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Wrap the first place `quote` appears in a rendered message in marks made
 * by `makeMark()` (one per text node it spans). Formatting like *italics*
 * is ignored when matching, since it isn't visible.
 */
export function markQuote(content, quote, makeMark, { ignoreCase = false } = {}) {
  quote = quote.replace(/[*_]/g, "").trim();
  if (!quote) return;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  while (walker.nextNode()) {
    nodes.push({ node: walker.currentNode, start: text.length });
    text += walker.currentNode.nodeValue;
  }
  const start = ignoreCase ? text.toLowerCase().indexOf(quote.toLowerCase()) : text.indexOf(quote);
  if (start < 0) return;
  const end = start + quote.length;
  // Wrap the part of each text node that falls inside the quote.
  for (const { node, start: nodeStart } of nodes) {
    const nodeEnd = nodeStart + node.nodeValue.length;
    if (nodeEnd <= start || nodeStart >= end) continue;
    const range = document.createRange();
    range.setStart(node, Math.max(0, start - nodeStart));
    range.setEnd(node, Math.min(node.nodeValue.length, end - nodeStart));
    range.surroundContents(makeMark());
  }
}

/** The first letter of a name, for avatars. */
export function initial(name) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** "14:05" for today, "Sep 24, 14:05" for older messages. */
export function formatTime(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function badge(text) {
  const span = document.createElement("span");
  span.className = "entry-badge";
  span.textContent = text;
  return span;
}

/**
 * The line a folded run of quiet turns shows: how many, and what they did,
 * most frequent first. Reasons in brackets are dropped, so seven "chose not
 * to reply (…)" lines with different reasons count as one action, 7×.
 * `turns` is one list of tool calls per turn (empty for a turn that only thought).
 */
export function quietSummary(turns) {
  const counts = new Map();
  let errors = 0;
  for (const calls of turns) {
    const done = new Set();
    for (const call of calls) {
      if (call.status === "ok") done.add(call.summary.replace(/\s*\(.*\)\s*$/s, "").trim());
      else errors++;
    }
    for (const action of done) counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const actions = [...counts].sort((a, b) => b[1] - a[1]).map(([action, n]) => (n > 1 ? `${action} ${n}×` : action));
  const shown = actions.slice(0, 3);
  if (actions.length > 3) shown.push(`${actions.length - 3} more`);
  return (
    `${turns.length} quiet turn${turns.length === 1 ? "" : "s"}` +
    (shown.length ? ` · ${shown.join(", ")}` : "") +
    (errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : "")
  );
}
