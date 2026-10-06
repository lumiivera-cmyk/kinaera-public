/**
 * Health, on a kinwriter's page (src/health.ts): how their tools and notes
 * are doing, by shape only. Counts, tool names and lengths, never what was
 * written.
 *
 * Under it, only when the server runs with DEVELOPER_PANEL=1: a link to the
 * developer panel (src/developer.ts), every private note in one view. The
 * kinwriter's prompt says the developer may open it, and opening it isn't
 * logged or announced.
 */

import { $, api, state } from "./core.js";

const details = $("self-health");
const body = $("self-health-body");

async function renderHealth() {
  body.textContent = "Looking…";
  try {
    const report = await api("GET", "/api/health");
    const parts = [];
    const findings = document.createElement("ul");
    findings.className = "health-findings";
    findings.append(
      ...report.findings.map((f) => {
        const item = document.createElement("li");
        item.className = `health-${f.level}`;
        item.textContent = `${f.level === "watch" ? "⚠ " : "✓ "}${f.text}`;
        return item;
      }),
    );
    parts.push(findings);

    if (report.tools.length) {
      const tools = fold(`Tool calls this week (${report.tools.reduce((n, t) => n + t.ok + t.failed, 0)})`);
      const list = document.createElement("ul");
      list.className = "health-list";
      list.append(
        ...report.tools.map((t) => {
          const item = document.createElement("li");
          item.textContent = `${t.name}: ${t.ok} ok${t.failed ? `, ${t.failed} failed` : ""}`;
          return item;
        }),
      );
      tools.append(list);
      parts.push(tools);
    }

    const limits = fold("How full things are");
    const list = document.createElement("ul");
    list.className = "health-list";
    list.append(
      ...report.limits.map((l) => {
        const item = document.createElement("li");
        const percent = Math.round((l.used / l.limit) * 100);
        item.textContent = `${l.what}: ${l.used.toLocaleString()} of ${l.limit.toLocaleString()} (${percent}%)`;
        return item;
      }),
    );
    limits.append(list);
    parts.push(limits);

    if (state.developerPanel) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "link-button health-developer";
      open.textContent = "Developer panel…";
      open.addEventListener("click", openDeveloper);
      parts.push(open);
    }
    body.replaceChildren(...parts);
  } catch (error) {
    body.textContent = error.message;
  }
}

function fold(title) {
  const d = document.createElement("details");
  const s = document.createElement("summary");
  s.textContent = title;
  d.append(s);
  return d;
}

/** The developer panel: every private note, organised by kind. */
async function openDeveloper() {
  const box = $("developer-body");
  box.textContent = "Loading…";
  $("developer-dialog").showModal();
  try {
    const data = await api("GET", "/api/developer");
    const section = (title, items, line) => {
      const d = fold(`${title} (${items.length})`);
      d.open = items.length > 0 && items.length < 6;
      for (const item of items) {
        const pre = document.createElement("pre");
        pre.className = "developer-item";
        pre.textContent = line(item);
        d.append(pre);
      }
      if (!items.length) d.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "None." }));
      return d;
    };
    box.replaceChildren(
      section("Journal", data.journal, (e) => `[${e.id}] ${e.createdAt.slice(0, 16)}${e.kept ? " (kept)" : ""}\n${e.content}`),
      section("Drafts", data.drafts, (d) => `[${d.id}] ${d.title || "(untitled)"}${d.channel ? ` for #${d.channel}` : ""}\n${d.content}`),
      section("Notes on others", data.notesOnOthers, (n) => `${n.name}\n${n.note}`),
      section("Profile notes", data.profileNotes, (n) => `${n.profile}\n${n.note}`),
      section("Hidden notebook entries", data.hiddenEntries, (e) =>
        [`${e.name} (${e.kind})`, ...e.fields.filter((f) => f.value).map((f) => `${f.label}: ${f.value}`), e.notes ? `Notes: ${e.notes}` : ""].filter(Boolean).join("\n"),
      ),
      section("Hidden DMs", data.hiddenDms, (d) => `#${d.channel}\n${d.messages.map((m) => `${m.from}: ${m.content}`).join("\n")}`),
      section("Orientation invite note", data.invitationNote ? [data.invitationNote] : [], (n) => n),
    );
  } catch (error) {
    box.textContent = error.message;
  }
}

details.addEventListener("toggle", () => {
  if (details.open) renderHealth();
});
