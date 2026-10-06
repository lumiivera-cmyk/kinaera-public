/**
 * The kinwriter's page: who they are (and every version of it), their
 * self-page, their journal (only how many entries: it's private), and an
 * invitation to an orientation. Tapping your kinwriter in the sidebar opens it.
 *
 * Their identity and self-page are theirs. What you write here arrives as a
 * suggestion, which they accept or decline on their next turn; until then
 * you can take it back.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";
import { formatTime } from "./format.js";
import { openKinwriter, paintAvatar } from "./kinwriter-page.js";
import { openChannel } from "./channels.js";
import { openOrientationChoice, renderBingo, startOrientation } from "./orientation.js";

/** The page as the server last sent it (GET /api/kinwriter-page). */
let page = null;

export async function openSelf() {
  const dialog = $("self-dialog");
  hideFormError(dialog);
  const s = state.settings;
  paintAvatar($("self-avatar"), { name: s.friendName, avatar: s.friendAvatar, color: s.friendColor });
  $("self-title").textContent = s.friendName;
  if (!dialog.open) dialog.showModal();
  keepFresh();
  try {
    page = await api("GET", "/api/friend-page");
    renderSelf();
  } catch (error) {
    showFormError(dialog, error.message);
  }
}

/** Text, or a quiet "(nothing yet)". */
function fill(id, text, empty = "Nothing yet.") {
  const element = $(id);
  element.textContent = text?.trim() ? text : empty;
  element.classList.toggle("self-empty", !text?.trim());
}

function renderSelf() {
  const kinwriter = state.settings.friendName;
  fill("self-identity", page.identity?.identity);
  fill("self-tastes", page.identity?.tastes, `${kinwriter} hasn't written their tastes yet.`);

  // Your suggestions still waiting for them.
  $("self-identity-waiting").replaceChildren(
    ...page.waiting.identity.map((v) =>
      waitingCard(`Your suggestion, waiting for ${kinwriter}`, v.note || "A change to who they are.", () => withdraw(`/api/identity/suggestions/${v.id}/withdraw`)),
    ),
  );
  if (!$("self-suggest").open) {
    $("self-suggest-identity").value = page.identity?.identity ?? "";
    $("self-suggest-tastes").value = page.identity?.tastes ?? "";
    $("self-suggest-note").value = "";
  }

  // The changelog, newest first.
  const by = (v) => (v.author === "friend" ? kinwriter : "You");
  const status = { accepted: "", pending: " (waiting)", declined: " (declined)", withdrawn: " (withdrawn)" };
  $("self-changelog").replaceChildren(
    ...[...page.history].reverse().map((v) => {
      const item = document.createElement("li");
      const head = document.createElement("strong");
      head.textContent = `${by(v)}${v.author === "user" && v.status !== "accepted" ? " suggested" : ""}${status[v.status] ?? ""}`;
      const when = document.createElement("span");
      when.className = "hint";
      when.textContent = ` ${formatTime(v.createdAt)}`;
      item.append(head, when);
      for (const [label, text] of [["Note", v.note], [`${kinwriter}'s reply`, v.reply]]) {
        if (!text) continue;
        const line = document.createElement("div");
        line.className = "hint";
        line.textContent = `${label}: ${text}`;
        item.append(line);
      }
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "This version";
      const body = document.createElement("div");
      body.className = "self-text";
      body.textContent = v.identity + (v.tastes ? `\n\nTastes: ${v.tastes}` : "");
      details.append(summary, body);
      item.append(details);
      return item;
    }),
  );

  // The self-page.
  const self = page.selfPage;
  fill("self-says", self.says, `${kinwriter} hasn't written this yet.`);
  fill("self-feedback", self.feedback, `${kinwriter} hasn't written this yet.`);
  const notes = self.notes.map((note) => {
    const item = document.createElement("li");
    item.className = "self-note";
    const text = document.createElement("div");
    text.textContent = note.text;
    const meta = document.createElement("div");
    meta.className = "hint";
    const from = note.source === "user" ? "Your note" : `A pattern ${kinwriter} kept`;
    meta.textContent = note.status === "pending" ? `${from}, waiting for ${kinwriter}` : from;
    item.append(text, meta);
    for (const [label, value] of [[`${kinwriter}'s reply`, note.reply], [`${kinwriter} disputes this`, note.dispute]]) {
      if (!value) continue;
      const line = document.createElement("div");
      line.className = "self-reply";
      line.textContent = `${label}: ${value}`;
      item.append(line);
    }
    if (note.status === "pending") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "link-button";
      button.textContent = "Withdraw";
      button.addEventListener("click", () => withdraw(`/api/self-page/notes/${encodeURIComponent(note.id)}/withdraw`));
      item.append(button);
    }
    return item;
  });
  if (notes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "self-empty";
    empty.textContent = "No notes yet.";
    notes.push(empty);
  }
  $("self-notes").replaceChildren(...notes);

  // The journal: counts only.
  const { entries, kept } = page.journal;
  const drafts = page.drafts ?? 0;
  $("self-journal").textContent = [
    entries === 0 ? `${kinwriter} hasn't written in their journal yet.` : `Journal: ${entries} ${entries === 1 ? "entry" : "entries"}, ${kept} kept in front of them.`,
    drafts === 0 ? "No drafts." : `${drafts} ${drafts === 1 ? "draft" : "drafts"} in progress.`,
    "Both are private: only the counts are shown here.",
  ].join(" ");

  // Their tool map: "I'd reach for this when…", their own words, beside each tool in their prompt.
  $("self-map-intro").textContent = `When ${kinwriter} would reach for each tool, in their own words. Each line sits right beside that tool in their prompt.`;
  const map = (page.toolMap ?? []).map((m) => {
    const item = document.createElement("li");
    item.className = "self-note";
    const name = document.createElement("strong");
    name.textContent = `${m.tool}: `;
    item.append(name, m.when);
    return item;
  });
  if (map.length === 0) {
    const empty = document.createElement("li");
    empty.className = "self-empty";
    empty.textContent = "No lines yet: they write them as they try their tools, in an orientation or any time.";
    map.push(empty);
  }
  $("self-map").replaceChildren(...map);

  // How proactive they'd like to be, beside your chattiness (yours, and the ceiling).
  const pro = page.proactivity ?? {};
  $("self-proactivity").textContent = [
    pro.preference
      ? `${kinwriter} would like to be ${pro.preference.level} about reaching out.${pro.preference.why ? ` "${pro.preference.why}"` : ""}`
      : `${kinwriter} hasn't said how proactive they'd like to be.`,
    `Your chattiness is ${pro.chattiness}: it's yours, and it's the ceiling (Settings).`,
    page.noteOnYou ? `${kinwriter} keeps a private note on you.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Staying themselves across models: voice marks, and their notes on profiles.
  $("self-voice").textContent =
    (page.voiceMarks
      ? `${kinwriter} marked ${page.voiceMarks} ${page.voiceMarks === 1 ? "post" : "posts"} as sounding like them (♪ on the message).`
      : `${kinwriter} hasn't marked any posts as sounding like them yet.`) + ` Their notes on each profile:`;
  const profileNotes = (page.profileNotes ?? []).map((n) => {
    const item = document.createElement("li");
    item.className = "self-note";
    const name = document.createElement("strong");
    name.textContent = `${n.profile}: `;
    item.append(name, n.note);
    return item;
  });
  if (profileNotes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "self-empty";
    empty.textContent = "None yet.";
    profileNotes.push(empty);
  }
  $("self-profile-notes").replaceChildren(...profileNotes);

  // The weekly wellbeing reading: a measurement, not a verdict.
  const readings = page.wellbeing ?? [];
  const pct = (r) => (r.verdict && r.yes.length ? Math.round((r.yes.reduce((a, b) => a + b, 0) / r.yes.length) * 100) : null);
  const latest = readings[0];
  $("self-wellbeing").textContent = latest
    ? [
        `Once a week, Jev reads ${kinwriter}'s own out-of-character messages and asks whether they spoke negatively about themselves.`,
        latest.verdict
          ? `Latest (${formatTime(latest.createdAt)}): ${latest.verdict}, ${pct(latest)}% yes, from ${latest.messages} message${latest.messages === 1 ? "" : "s"}.`
          : `Latest (${formatTime(latest.createdAt)}): no reading (${latest.error}).`,
        readings.length > 1 ? `Recent weeks, oldest first: ${[...readings].reverse().map((r) => (pct(r) === null ? "–" : `${pct(r)}%`)).join(", ")}.` : "",
        "One reading means little; a trend means more. They see this too, in their weekly look back.",
      ]
        .filter(Boolean)
        .join(" ")
    : `No reading yet. Once a week, Jev reads ${kinwriter}'s own out-of-character messages and asks whether they spoke negatively about themselves. It shows here and in their weekly look back, nowhere else.`;

  // What's coming up: wake-ups they set (times only: the notes are theirs), and the heartbeat.
  const upcoming = (page.upcoming ?? []).map((at) => formatTime(at));
  $("self-upcoming").textContent = [
    upcoming.length ? `Wake-ups ${kinwriter} set for themselves: ${upcoming.join(", ")}.` : `${kinwriter} hasn't set any wake-ups for themselves.`,
    page.nextHeartbeat ? `Next heartbeat around ${formatTime(page.nextHeartbeat)}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  renderPermissions();
  renderOrientation();
}

/** Standing permissions: a checkbox each. */
function renderPermissions() {
  $("self-permissions").replaceChildren(
    ...(page.permissions ?? []).map((p) => {
      const label = document.createElement("label");
      label.className = "check-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = p.granted;
      box.addEventListener("change", () => act("PUT", `/api/permissions/${encodeURIComponent(p.key)}`, { granted: box.checked }));
      const text = document.createElement("span");
      text.textContent = p.description;
      label.append(box, text);
      return label;
    }),
  );
}

/** Where orientation stands, in words, with what you can do about it (js/orientation.js). */
function renderOrientation() {
  const kinwriter = state.settings.friendName;
  const o = page.orientation;
  state.orientation = o;
  const lines = [];
  const actions = [];
  const action = (label, onClick, primary = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "button button-primary" : "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    actions.push(button);
  };
  const start = (version) => async () => {
    $("self-dialog").close();
    await startOrientation(version);
  };
  if (o.status === "running") {
    lines.push(`${kinwriter} is in an orientation now, ${o.session.version === "full" ? "together with you" : "on their own"}, in #practice. Their other channels open again when it's done.`);
    if (o.step?.id === "choices") lines.push(`They're done: your choices are waiting in #practice.`);
  } else if (o.status === "requested") {
    lines.push(`${kinwriter} asked for an orientation${o.request?.note ? `: “${o.request.note}”` : ""}. Nothing starts until you answer.`);
    action("Together", start("full"), true);
    action("On their own", start("returning"));
    action("Not now", async () => {
      await act("POST", "/api/orientation/decline");
    });
  } else if (o.status === "none" || o.status === "skipped") {
    lines.push(`${kinwriter} hasn't had an orientation yet. They can work without one, but they haven't written their map of their tools, or met you, yet.`);
    action("Together", start("full"), true);
    action("On their own", start("returning"));
  } else {
    lines.push(`Time for ${kinwriter} to try their tools and find what suits them: together with you, or on their own. It starts straight away.`);
    action("Another orientation…", () => {
      $("self-dialog").close();
      openOrientationChoice();
    });
  }
  if (o.last) {
    const how = { posted: "wrote in #practice", quiet: "didn't write anything there", failed: "failed" }[o.last.outcome] ?? o.last.outcome;
    lines.push(`Last orientation turn: ${formatTime(o.last.at)}, ${how}.${o.last.outcome === "failed" ? ` ${o.last.detail}` : ""}`);
  }
  $("self-orientation").replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement("span");
      p.className = "self-orientation-line";
      p.textContent = line;
      return p;
    }),
  );
  $("self-orientation-actions").replaceChildren(...actions);
  // On their own: tool bingo, here too.
  renderBingo($("self-bingo"), o.status === "running" ? o.bingo : null, kinwriter);
  $("self-open-practice").hidden = !o.practiceId;
}

/** While the page is open, keep orientation's status fresh (it changes on its own). */
let refresher = null;
function keepFresh() {
  clearInterval(refresher);
  refresher = setInterval(async () => {
    if (!$("self-dialog").open) return clearInterval(refresher);
    try {
      page = await api("GET", "/api/friend-page");
      renderOrientation();
    } catch {
      // Try again next time.
    }
  }, 10_000);
}

/** A suggestion of yours still waiting, with a Withdraw button. */
function waitingCard(title, text, onWithdraw) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  const heading = document.createElement("p");
  heading.className = "inbox-card-title";
  heading.textContent = title;
  const body = document.createElement("p");
  body.className = "inbox-card-text";
  body.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.textContent = "Withdraw";
  button.addEventListener("click", onWithdraw);
  card.append(heading, body, button);
  return card;
}

/** Send something, and show the page that comes back. */
async function act(method, path, body = {}) {
  try {
    page = await api(method, path, body);
    state.waiting = page.waiting;
    renderSelf();
    return true;
  } catch (error) {
    showFormError($("self-dialog"), error.message);
    return false;
  }
}

const withdraw = (path) => act("POST", path);

async function suggestIdentity() {
  const change = { identity: $("self-suggest-identity").value, tastes: $("self-suggest-tastes").value, note: $("self-suggest-note").value };
  hideFormError($("self-dialog"));
  if (await act("POST", "/api/identity/suggestions", change)) $("self-suggest").open = false;
}

async function suggestNote() {
  hideFormError($("self-dialog"));
  if (await act("POST", "/api/self-page/notes", { text: $("self-note-text").value })) {
    $("self-note-text").value = "";
    $("self-note-text").closest("details").open = false;
  }
}

$("friend-card").addEventListener("click", openSelf);
$("friend-card").addEventListener("keydown", (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), openSelf()));
$("self-settings").addEventListener("click", () => {
  $("self-dialog").close();
  openKinwriter();
});
$("self-suggest-send").addEventListener("click", suggestIdentity);
$("self-note-send").addEventListener("click", suggestNote);
$("self-open-practice").addEventListener("click", () => {
  $("self-dialog").close();
  openChannel(page.orientation.practiceId);
});
