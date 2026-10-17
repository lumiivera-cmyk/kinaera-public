/**
 * Data folders (src/datafolders.ts), in the developer panel: only with
 * DEVELOPER_PANEL=1, for now.
 *
 * - **Start fresh**: what `bun run fresh` does, from here: every kinwriter's
 *   memory is set aside (the data folder becomes `data-old-<date>`), and
 *   you make a new kinwriter. Your profiles, preferences, themes and prompt
 *   edits carry over.
 * - **Old folders**: each one, with its kinwriters. Open one to read their
 *   channels (read-only, from a copy), export them as a file, or bring them
 *   back as a new kinwriter.
 * - **Export** any kinwriter here now, and **import** an exported file.
 */

import { $, api } from "./core.js";

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const button = (label, onClick, primary = false) => {
  const b = el("button", { type: "button", className: primary ? "button button-primary" : "button", textContent: label });
  b.addEventListener("click", onClick);
  return b;
};
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");
const base = (folder, id) => `/api/hub/dev/folders/${encodeURIComponent(folder)}/kinwriters/${encodeURIComponent(id)}`;

/** Download a kinwriter as one file (their database and emoji images). */
function exportKinwriter(folder, id) {
  const link = el("a", { href: `${base(folder, id)}/export`, download: "" });
  document.body.append(link);
  link.click();
  link.remove();
}

/** One kinwriter's line: who, how much, and what you can do. */
function kinwriterRow(folder, k, status) {
  const what = k.error
    ? `couldn't be read (${k.error})`
    : `${k.channels} channel${k.channels === 1 ? "" : "s"}, ${k.messages} message${k.messages === 1 ? "" : "s"}, last ${when(k.lastMessageAt)}${k.archived ? ", archived" : ""}`;
  const row = el("li", { className: "data-folder-kinwriter" }, el("strong", { textContent: `${k.avatar ? `${k.avatar} ` : ""}${k.name}` }), el("span", { className: "hint", textContent: ` ${what}` }));
  if (k.error) return row;
  const actions = el("div", { className: "memory-buttons" });
  if (folder !== "current") actions.append(button("Open", () => browseKinwriter(folder, k)));
  actions.append(button("Export", () => exportKinwriter(folder, k.id)));
  if (folder !== "current") {
    actions.append(
      button("Bring back", async () => {
        if (!confirm(`Bring ${k.name} back as a new kinwriter, on a server of their own? Their old folder stays as it is.`)) return;
        try {
          await api("POST", `${base(folder, k.id)}/import`, {});
          status.textContent = `${k.name} is back, on a server of their own. Reloading…`;
          setTimeout(() => location.reload(), 800);
        } catch (error) {
          status.textContent = error.message;
        }
      }),
    );
  }
  row.append(actions);
  return row;
}

/** Fill the "Data folders" section of the developer panel. */
export async function renderDataFolders() {
  const box = $("data-folders-body");
  box.textContent = "Loading…";
  try {
    const { current, old } = await api("GET", "/api/hub/dev/folders");
    const status = el("p", { className: "hint", role: "status" });

    // Start fresh.
    const fresh = el(
      "div",
      { className: "data-folder" },
      el("h4", { className: "self-subtitle", textContent: "Start fresh" }),
      el("p", {
        className: "hint",
        textContent:
          "Sets every kinwriter's memory aside (this data folder becomes an old folder, listed below) and opens on making a new kinwriter. Your connection profiles, roulettes, preferences, themes and prompt edits carry over. Nothing is deleted.",
      }),
      button("Start fresh…", async () => {
        if (!confirm("Start fresh? Every kinwriter is set aside in an old folder, and you make a new one.")) return;
        if (!confirm("Sure? You can bring any of them back from the old folder later.")) return;
        try {
          const result = await api("POST", "/api/hub/dev/fresh", {});
          status.textContent = `Done: the old folder is ${result.aside}. Reloading…`;
          setTimeout(() => location.reload(), 800);
        } catch (error) {
          status.textContent = error.message;
        }
      }),
    );

    // Import an exported file.
    const file = el("input", { type: "file", accept: ".json,application/json" });
    file.addEventListener("change", async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try {
        const bundle = JSON.parse(await chosen.text());
        await api("POST", "/api/hub/dev/import", bundle);
        status.textContent = `${bundle.name ?? "They"} came in as a new kinwriter, on a server of their own. Reloading…`;
        setTimeout(() => location.reload(), 800);
      } catch (error) {
        status.textContent = error instanceof SyntaxError ? "That file isn't an exported kinwriter." : error.message;
      }
      file.value = "";
    });
    const importer = el(
      "div",
      { className: "data-folder" },
      el("h4", { className: "self-subtitle", textContent: "Import a kinwriter" }),
      el("p", { className: "hint", textContent: "An exported kinwriter file (.kinwriter.json): they come in as a new kinwriter, on a server of their own." }),
      file,
    );

    const folderBox = (folder, title) =>
      el(
        "div",
        { className: "data-folder" },
        el("h4", { className: "self-subtitle", textContent: title }),
        el("ul", { className: "data-folder-list" }, ...folder.kinwriters.map((k) => kinwriterRow(folder.id, k, status))),
      );

    box.replaceChildren(
      status,
      fresh,
      importer,
      folderBox(current, "Now"),
      ...(old.length
        ? old.map((folder) => folderBox(folder, `${folder.id} (set aside ${when(folder.modifiedAt)})`))
        : [el("p", { className: "hint", textContent: "No old folders yet." })]),
    );
  } catch (error) {
    box.textContent = error.message;
  }
}

// ------------------------------------------------------- reading one

/** An old kinwriter, read-only: their channels, then a channel's messages. */
async function browseKinwriter(folder, k) {
  const dialog = $("old-kinwriter-dialog");
  const body = $("old-kinwriter-body");
  $("old-kinwriter-title").textContent = `${k.avatar ? `${k.avatar} ` : ""}${k.name}`;
  $("old-kinwriter-where").textContent = `In ${folder}, read-only: nothing here changes the old folder. Their journal, drafts and DMs aren't shown.`;
  body.textContent = "Loading…";
  if (!dialog.open) dialog.showModal();
  try {
    const data = await api("GET", base(folder, k.id));
    body.replaceChildren(
      el("p", { className: "hint", textContent: data.identity ? `Who they were: ${data.identity}` : "" }),
      el(
        "ul",
        { className: "data-folder-list" },
        ...data.channels.map((c) =>
          el("li", {}, button(`#${c.name} (${c.messages})`, () => browseChannel(folder, k, c.id))),
        ),
      ),
    );
  } catch (error) {
    body.textContent = error.message;
  }
}

async function browseChannel(folder, k, channelId, before = null, earlier = []) {
  const body = $("old-kinwriter-body");
  try {
    const data = await api("GET", `${base(folder, k.id)}/channels/${encodeURIComponent(channelId)}${before ? `?before=${encodeURIComponent(before)}` : ""}`);
    const messages = [...data.messages, ...earlier];
    const who = (m) => (m.author === "kinwriter" ? k.name : m.author === "user" ? "You" : (m.speaker ?? m.author));
    const list = el(
      "ol",
      { className: "old-messages" },
      ...messages.map((m) =>
        m.kind === "scene_break"
          ? el("li", { className: "hint", textContent: `— ${m.content || "scene break"} —` })
          : el("li", {}, el("strong", { textContent: `${who(m)} ` }), el("span", { className: "hint", textContent: when(m.createdAt) }), el("div", { className: "old-message", textContent: m.content })),
      ),
    );
    const head = el("div", { className: "memory-buttons" }, button("← Channels", () => browseKinwriter(folder, k)));
    if (data.more) head.append(button("Earlier messages", () => browseChannel(folder, k, channelId, messages[0].id, messages)));
    body.replaceChildren(el("h4", { className: "self-subtitle", textContent: `#${data.channel.name}` }), head, list);
  } catch (error) {
    body.textContent = error.message;
  }
}

$("data-folders").addEventListener("toggle", () => {
  if ($("data-folders").open) renderDataFolders();
});
