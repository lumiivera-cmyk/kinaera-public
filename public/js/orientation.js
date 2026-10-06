/**
 * Orientation in the app (src/orientation.ts): choosing it, and watching
 * it happen.
 *
 *   - **Choosing.** A new kinwriter is offered one when you open them:
 *     together (the default) or on their own, with Skip under Advanced.
 *     Their page offers it too, and shows their request if they asked.
 *   - **Running.** It happens in their #practice. A panel there says where
 *     things are and shows the live feed: each tool they use, in a few
 *     words (a private one only as having happened). Together, you can
 *     write in #practice, and you end it with Finish. On their own, it ends
 *     by itself.
 *   - **Their other channels wait** while it runs: the composer there says
 *     so instead.
 */

import { $, api, currentChannel, hideFormError, showFormError, state } from "./core.js";

const dialog = $("orientation-dialog");
const panel = $("orientation-panel");

/** The orientation as the server last told us. */
const running = () => (state.orientation?.status === "running" ? state.orientation.session : null);

// ------------------------------------------------------------- choosing

/** Offer one to a kinwriter who's never had one (on opening them). Returns whether it did. */
export function maybeOfferOrientation() {
  if (state.setup || state.orientation?.status !== "none" || dialog.open) return false;
  openOrientationChoice();
  return true;
}

/** The choice: together, on their own, or (under Advanced) skip. */
export function openOrientationChoice() {
  const name = state.settings.friendName;
  const o = state.orientation ?? {};
  hideFormError(dialog);
  $("orientation-dialog-title").textContent = o.status === "requested" ? `${name} asked for an orientation` : `An orientation with ${name}`;
  $("orientation-dialog-why").textContent =
    o.status === "requested"
      ? `${o.request?.note ? `“${o.request.note}” ` : ""}Nothing starts until you pick one, and it starts straight away.`
      : `${name} tries their tools and finds what suits them, and you see what they can do. It starts straight away, in their #practice channel.`;
  $("orientation-full").textContent = "Together";
  $("orientation-full-hint").textContent = `You and ${name}, live: you talk in #practice and watch each tool they use. The best way for them to meet you. Their other channels wait until you finish.`;
  $("orientation-returning").textContent = `${name} on their own`;
  $("orientation-returning-hint").textContent = `For when you've done one together before. They go through it alone, turn after turn, with a practice scene and a stand-in partner, while you watch their tool bingo fill. At the end, you choose what to keep.`;
  // Skip is for one never had; a request gets "not now" instead.
  $("orientation-advanced").hidden = o.status === "requested";
  $("orientation-advanced").open = false;
  $("orientation-skip-hint").textContent = `They can still work, but they haven't written their map of their tools, or met you, yet. Their page keeps offering it.`;
  $("orientation-later").textContent = o.status === "requested" ? "Not now" : "Later";
  dialog.showModal();
}

async function choose(path, body) {
  try {
    const data = await api("POST", path, body ?? {});
    state.orientation = data.orientation;
    dialog.close();
    return data;
  } catch (error) {
    showFormError(dialog, error.message);
    return null;
  }
}

/** Start one: it opens their #practice, where it happens. */
export async function startOrientation(version) {
  const data = await choose("/api/orientation/start", { version });
  if (!data) return;
  const { openChannel } = await import("./channels.js");
  await openChannel(data.orientation.session.channelId);
  renderOrientation();
}

$("orientation-full").addEventListener("click", () => startOrientation("full"));
$("orientation-returning").addEventListener("click", () => startOrientation("returning"));
$("orientation-skip").addEventListener("click", async () => {
  if (await choose("/api/orientation/skip")) renderOrientation();
});
$("orientation-later").addEventListener("click", async (event) => {
  // For their request, "Not now" is an answer, and they're told.
  if (state.orientation?.status === "requested") {
    event.preventDefault();
    if (await choose("/api/orientation/decline")) renderOrientation();
  }
});

// ------------------------------------------------------------- running

let feedTimer = null;
let lastFeedId = null;

/** Draw the panel and the composer note for the open channel, and keep the feed coming. */
export function renderOrientation() {
  const session = running();
  const channel = currentChannel();
  // It happens in #practice, and in the starter scene once that's made.
  const here = Boolean(session && channel && [session.channelId, session.scene].includes(channel.id));
  const name = state.settings.friendName;
  panel.hidden = !here;
  // Their other channels wait while it runs.
  const note = $("orienting-note");
  const elsewhere = Boolean(session && channel && !here);
  note.hidden = !elsewhere;
  if (elsewhere) note.textContent = `${name} is in an orientation, in #practice. This channel opens again when it's done.`;
  $("composer-form").hidden ||= elsewhere;
  if (!here) return stopFeed();

  const together = session.version === "full";
  const step = state.orientation.step;
  const named = (text) => (text ?? "").replaceAll("{name}", name);
  $("orientation-title").textContent = together ? `Orientation with ${name}` : `${name}'s orientation`;
  $("orientation-step").textContent = step ? `Step ${step.index + 1} of ${step.count}` : "";
  $("orientation-step-title").textContent = step?.title ?? "";
  // Your card: plain words, no model call. On their own, a line on what they're doing.
  // On their own, a line on what they're doing, until your choices at the end.
  const choosing = step?.id === "choices";
  const card = together || choosing ? named(step?.card) : `${name} is going through it on their own, step after step. Each tool they use shows up below. When they're done, you choose what to keep.`;
  $("orientation-card").replaceChildren(
    ...card
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => Object.assign(document.createElement("p"), { className: "hint", textContent: p })),
  );
  renderExtras(together || choosing ? step : null, named);
  renderBingo($("orientation-bingo"), together || choosing ? null : state.orientation.bingo, name);
  renderMade(together ? step : null, name);
  renderGoScene(together ? step : null);
  // A step you try first: their turn comes when you hand it over.
  const hand = $("orientation-hand-over");
  hand.hidden = !(together && step?.waiting);
  hand.textContent = `Hand it to ${name}`;
  hand.disabled = state.orientation.writing === true;
  $("orientation-spotlight").hidden = !(together && step?.spotlights?.length);
  const next = $("orientation-next");
  next.hidden = !(together || choosing);
  const last = step && step.index + 1 >= step.count;
  next.textContent = last ? "Finish" : "Next";
  // Their part of a step is theirs to finish first.
  next.disabled = state.orientation.writing === true;
  next.title = next.disabled ? `${name} is still writing` : "";
  $("orientation-finish").hidden = !together || last;
  startFeed();
}

/**
 * What's been made so far, on the steps it matters to: your character (or
 * the form for it), and each side's secrets, as counts.
 */
function renderMade(step, name) {
  const box = $("orientation-made");
  const made = state.orientation.made;
  const show = step && made && ["characters", "scene"].includes(step.id);
  box.hidden = !show;
  if (!show) return;
  const lines = [];
  if (made.theirs.length) lines.push(`${name} plays ${made.theirs.map((c) => c.name).join(", ")}.`);
  if (made.theirSecrets) lines.push(`${name} is keeping ${made.theirSecrets === 1 ? "a secret" : `${made.theirSecrets} secrets`}.`);
  if (made.yours.length) lines.push(`You play ${made.yours.map((c) => c.name).join(", ")}${made.yourSecrets ? `, keeping ${made.yourSecrets === 1 ? "a secret" : `${made.yourSecrets} secrets`}` : ""}.`);
  $("orientation-made-lines").textContent = lines.join(" ");
  // Your character, once: a name, a line or two, one secret.
  $("orientation-character").hidden = step.id !== "characters" || made.yours.length > 0;
}

/** The scene is in its own channel: a way there, on the steps that use it. */
function renderGoScene(step) {
  const scene = state.orientation.session?.scene;
  $("orientation-go-scene").hidden = !(step && scene && ["scene", "editing", "profiles"].includes(step.id) && currentChannel()?.id !== scene);
}

$("orientation-character").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  hideFormError(event.target);
  try {
    const data = await api("POST", "/api/orientation/character", { name: form.name.value, about: form.about.value, secret: form.secret.value });
    state.orientation = data.orientation;
    event.target.reset();
    renderOrientation();
  } catch (error) {
    showFormError(event.target, error.message);
  }
});

$("orientation-go-scene").addEventListener("click", async () => {
  const { loadState } = await import("./live.js");
  await loadState();
  const { openChannel } = await import("./channels.js");
  await openChannel(state.orientation.session.scene);
});

/** A step's extras on your card: a table, and the closer's intervention log. */
function renderExtras(step, named) {
  const box = $("orientation-extras");
  const parts = [];
  if (step?.table) parts.push(markdownTable(named(step.table)));
  if (step?.id === "interview") parts.push(...interviewExtras());
  if (step?.id === "choices") parts.push(choicesForm(named));
  if (step?.id === "library") {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button";
    add.textContent = "Add the example";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "button";
    open.textContent = "Open the library";
    open.addEventListener("click", async () => {
      const { openLibrary } = await import("./library.js");
      openLibrary();
    });
    const said = Object.assign(document.createElement("p"), { className: "hint" });
    said.setAttribute("role", "status");
    add.addEventListener("click", async () => {
      try {
        const { document: doc } = await api("POST", "/api/orientation/library-example", {});
        said.textContent = `"${doc.title}" is in the library, open to every channel. Search it from the library.`;
      } catch (error) {
        said.textContent = error.message;
      }
    });
    const row = Object.assign(document.createElement("div"), { className: "memory-buttons" });
    row.append(add, open);
    parts.push(row, said);
  }
  if (step?.id === "closer") {
    const log = document.createElement("button");
    log.type = "button";
    log.className = "button";
    log.textContent = "Open the intervention log";
    log.addEventListener("click", async () => {
      const { openInterventions } = await import("./history.js");
      openInterventions();
    });
    parts.push(log);
  }
  // Keep what you're typing: only redraw when the step changes.
  if (box.dataset.step !== (step?.id ?? "") || !box.childElementCount) {
    box.dataset.step = step?.id ?? "";
    box.replaceChildren(...parts);
  }
  // The interview's nudge toward wrapping up, once you've each asked a handful.
  const wrap = document.getElementById("interview-wrap-up");
  if (wrap) {
    wrap.textContent = state.orientation.interview?.wrapUp ?? "";
    wrap.hidden = !wrap.textContent;
  }
}

/**
 * Tool bingo, for the version on their own: a square per tool, filled as
 * the feed shows them using it (private ones too, without what they wrote),
 * and how many secrets they're keeping. No model calls.
 */
export function renderBingo(box, bingo, name) {
  if (!box) return;
  box.hidden = !bingo;
  if (!bingo) return;
  const used = new Set(bingo.used);
  const grid = Object.assign(document.createElement("div"), { className: "bingo-grid" });
  for (const tool of bingo.tools) {
    const square = Object.assign(document.createElement("span"), { className: `bingo-square${used.has(tool) ? " filled" : ""}`, textContent: tool.replaceAll("_", " ") });
    grid.append(square);
  }
  // Folded away or open, as you left it.
  const details = box.querySelector("details") ?? Object.assign(document.createElement("details"), { open: true });
  const summary = Object.assign(document.createElement("summary"), {
    textContent: [`Tool bingo: ${used.size} of ${bingo.tools.length} tried.`, bingo.secrets ? `${name} is keeping ${bingo.secrets === 1 ? "1 secret" : `${bingo.secrets} secrets`}.` : ""].filter(Boolean).join(" "),
  });
  details.replaceChildren(summary, grid);
  if (!details.parentElement) box.replaceChildren(details);
}

/** Your quiet choices: a small form, sent by Finish. */
function choicesForm(named) {
  const info = state.orientation.choices ?? {};
  const form = Object.assign(document.createElement("form"), { id: "orientation-choices", className: "orientation-choices" });
  const alone = info.version === "returning";
  const group = (name, legend, options) => {
    const set = document.createElement("fieldset");
    set.append(Object.assign(document.createElement("legend"), { textContent: legend }));
    options.forEach(([value, label], i) => {
      const row = document.createElement("label");
      const input = Object.assign(document.createElement("input"), { type: "radio", name, value, checked: i === 0 });
      row.append(input, ` ${label}`);
      set.append(row);
    });
    return set;
  };
  form.append(
    group("characters", alone ? named("{name}'s character, and anything else made in the orientation") : "The characters and lore made in the orientation", [
      ["keep", "Keep them (secrets stay hidden)"],
      ["discard", "Discard them, with their notes"],
    ]),
  );
  if (info.sceneName && alone) {
    form.append(
      group("scene", `The practice scene, #${info.sceneName}`, [
        ["discard", "Discard it"],
        ["keep", named("Keep it as a starter: the partner becomes your character, picking up from {name}'s last line")],
      ]),
    );
  } else if (info.sceneName) {
    form.append(group("scene", `The starter scene, #${info.sceneName}`, [["keep", "Keep it as a story channel"], ["discard", "Delete it"]]));
  }
  if (!alone) {
    form.append(
      group("conversation", "The conversation in #practice", [
        ["keep", named("Keep it, so {name} remembers the orientation")],
        ["set-aside", "Set it aside"],
      ]),
    );
  }
  if (info.questions) {
    form.append(Object.assign(document.createElement("p"), { className: "hint", textContent: named(`{name} saved ${info.questions === 1 ? "a question" : `${info.questions} questions`} for you: they'll be in OOC, to answer whenever you like.`) }));
  }
  // Chattiness: yours, starting where they'd like to be.
  const label = Object.assign(document.createElement("label"), { textContent: "Chattiness from now on" });
  const select = Object.assign(document.createElement("select"), { name: "chattiness" });
  for (const level of ["off", "quiet", "normal", "chatty"]) select.append(Object.assign(document.createElement("option"), { value: level, textContent: level }));
  select.value = info.preference ?? info.chattiness ?? "normal";
  label.append(select);
  const hint = Object.assign(document.createElement("p"), {
    className: "hint",
    textContent: info.preference
      ? named(`{name} said they'd like to be ${info.preference}, so it starts there. It's yours, and you can change it any time in Settings.`)
      : "It's yours, and you can change it any time in Settings.",
  });
  form.append(label, hint);
  return form;
}

/** A few question cards at a time, shuffled; tap one to start your message with it. */
let cardsShown = [];
function interviewExtras() {
  const cards = Object.assign(document.createElement("div"), { className: "interview-cards" });
  const deal = () => {
    const all = state.orientation.interview?.cards ?? [];
    // Fresh ones first: the ones not just shown.
    const fresh = all.filter((q) => !cardsShown.includes(q));
    const pool = (fresh.length >= 3 ? fresh : all).slice().sort(() => Math.random() - 0.5);
    cardsShown = pool.slice(0, 3);
    cards.replaceChildren(
      ...cardsShown.map((question) => {
        const card = Object.assign(document.createElement("button"), { type: "button", className: "interview-card", textContent: question });
        card.addEventListener("click", () => {
          const input = $("composer-input");
          input.value = question;
          input.focus();
          input.dispatchEvent(new Event("input"));
        });
        return card;
      }),
    );
  };
  deal();
  const more = Object.assign(document.createElement("button"), { type: "button", className: "link-button", textContent: "More questions" });
  more.addEventListener("click", deal);

  // Keep something to yourself: they see only that you are.
  const keep = Object.assign(document.createElement("details"), { className: "interview-keep" });
  keep.append(Object.assign(document.createElement("summary"), { textContent: "Keep something to myself" }));
  const note = document.createElement("textarea");
  note.rows = 2;
  note.maxLength = 2000;
  note.placeholder = "Optional: a note for yourself. It's kept in your notebook, hidden from them.";
  const said = Object.assign(document.createElement("span"), { className: "hint" });
  const button = Object.assign(document.createElement("button"), { type: "button", className: "button", textContent: "Keep it" });
  button.addEventListener("click", async () => {
    try {
      await api("POST", "/api/orientation/keep", { note: note.value });
      note.value = "";
      keep.open = false;
      said.textContent = "";
      const { refreshMessages } = await import("./messages.js");
      await refreshMessages();
    } catch (error) {
      said.textContent = ` ${error.message}`;
    }
  });
  const row = Object.assign(document.createElement("div"), { className: "memory-buttons" });
  row.append(button, said);
  keep.append(
    Object.assign(document.createElement("p"), { className: "hint", textContent: "They see only that you're keeping something. Declining a question works the same way, or just say so." }),
    note,
    row,
  );
  const wrap = Object.assign(document.createElement("p"), { className: "hint", id: "interview-wrap-up", hidden: true });
  wrap.setAttribute("role", "status");
  return [cards, more, keep, wrap];
}

/** A small Markdown table ("| a | b |" lines) as HTML. */
function markdownTable(text) {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
  const table = document.createElement("table");
  table.className = "orientation-table";
  rows.forEach((cells, i) => {
    const tr = document.createElement("tr");
    for (const cell of cells) tr.append(Object.assign(document.createElement(i === 0 ? "th" : "td"), { textContent: cell }));
    table.append(tr);
  });
  const wrap = Object.assign(document.createElement("div"), { className: "orientation-table-wrap" });
  wrap.append(table);
  return wrap;
}

// ----------------------------------------------------------- spotlights

/** A tour of the real screen: each part outlined in turn, with a few words. */
async function spotlightTour(items, named) {
  const { closeSidebar, openSidebar } = await import("./channels.js");
  const card = document.createElement("div");
  card.className = "spotlight-card surface";
  card.setAttribute("role", "dialog");
  const text = document.createElement("p");
  const buttons = Object.assign(document.createElement("div"), { className: "memory-buttons" });
  const nextButton = Object.assign(document.createElement("button"), { type: "button", className: "button button-primary" });
  const done = Object.assign(document.createElement("button"), { type: "button", className: "link-button", textContent: "Done" });
  buttons.append(nextButton, done);
  card.append(text, buttons);
  document.body.append(card);
  let index = 0;
  let lit = null;
  const finish = () => {
    lit?.classList.remove("spotlit");
    card.remove();
    // On a phone, the sidebar the tour opened would cover the panel.
    closeSidebar();
  };
  const show = () => {
    lit?.classList.remove("spotlit");
    // Skip parts that aren't on this screen (no story channel yet, say).
    while (index < items.length && !document.querySelector(items[index].selector)) index++;
    if (index >= items.length) return finish();
    const element = document.querySelector(items[index].selector);
    // On a phone, the channels are in the sidebar.
    if (element.closest("#sidebar")) openSidebar();
    lit = element;
    lit.classList.add("spotlit");
    lit.scrollIntoView({ block: "nearest" });
    text.textContent = named(items[index].text);
    nextButton.textContent = index + 1 >= items.length ? "Done" : "Next";
  };
  nextButton.addEventListener("click", () => {
    index++;
    show();
  });
  done.addEventListener("click", finish);
  show();
}

$("orientation-spotlight").addEventListener("click", () => {
  const step = state.orientation?.step;
  const name = state.settings.friendName;
  if (step?.spotlights?.length) spotlightTour(step.spotlights, (t) => t.replaceAll("{name}", name));
});

$("orientation-hand-over").addEventListener("click", async () => {
  try {
    const data = await api("POST", "/api/orientation/hand-over", {});
    state.orientation = data.orientation;
    // Their part happens in #practice: over there, to watch.
    if (currentChannel()?.id !== data.orientation.session.channelId) {
      const { openChannel } = await import("./channels.js");
      await openChannel(data.orientation.session.channelId);
    } else renderOrientation();
  } catch (error) {
    alert(error.message);
  }
});

$("orientation-next").addEventListener("click", async () => {
  const step = state.orientation?.step;
  const last = step && step.index + 1 >= step.count;
  try {
    // Your choices go with Finish.
    const form = step?.id === "choices" ? document.getElementById("orientation-choices") : null;
    const data = form
      ? await api("POST", "/api/orientation/choices", Object.fromEntries(new FormData(form)))
      : await api("POST", "/api/orientation/next", {});
    state.orientation = data.orientation;
    if (last) {
      stopFeed();
      // Channels may have changed with your choices (the scene deleted, #practice set aside).
      const { loadState } = await import("./live.js");
      await loadState();
      const { openChannel } = await import("./channels.js");
      if (!currentChannel()) await openChannel(state.channels[0]?.id);
      else {
        const { refreshMessages } = await import("./messages.js");
        await refreshMessages();
      }
    } else if (data.orientation.step?.where === "scene" && data.orientation.session?.scene) {
      // The starter scene has its own channel: over there.
      const { loadState } = await import("./live.js");
      await loadState();
      const { openChannel } = await import("./channels.js");
      await openChannel(data.orientation.session.scene);
    } else renderOrientation();
  } catch (error) {
    alert(error.message);
  }
});

function startFeed() {
  if (feedTimer) return;
  lastFeedId = null;
  $("orientation-feed").replaceChildren();
  $("orientation-feed-count").textContent = "";
  void pollFeed();
  feedTimer = setInterval(pollFeed, 1500);
}

function stopFeed() {
  clearInterval(feedTimer);
  feedTimer = null;
}

async function pollFeed() {
  try {
    const data = await api("GET", `/api/orientation${lastFeedId ? `?after=${encodeURIComponent(lastFeedId)}` : ""}`);
    const was = state.orientation?.status;
    state.orientation = data.orientation;
    const list = $("orientation-feed");
    for (const item of data.feed) {
      const line = document.createElement("li");
      line.className = item.ok ? "" : "orientation-feed-failed";
      line.textContent = `${item.ok ? "⚙" : "✗"} ${item.text}`;
      list.append(line);
      lastFeedId = item.id;
    }
    $("orientation-feed-count").textContent = list.childElementCount ? `(${list.childElementCount})` : "";
    if (data.feed.length) list.lastElementChild?.scrollIntoView({ block: "nearest" });
    // The step, and whether they're still writing (Next waits for them).
    if (data.orientation.status === "running") renderOrientation();
    // It ended (on their own, or in another tab): everything opens again.
    if (was === "running" && data.orientation.status !== "running") {
      stopFeed();
      const { renderAll } = await import("./channels.js");
      renderAll();
    }
  } catch {
    // Try again next time.
  }
}

$("orientation-finish").addEventListener("click", async () => {
  const name = state.settings.friendName;
  if (!confirm(`End the orientation with ${name} now, skipping the steps left? Every channel opens again.`)) return;
  try {
    const data = await api("POST", "/api/orientation/finish", {});
    state.orientation = data.orientation;
    stopFeed();
    const { renderAll } = await import("./channels.js");
    renderAll();
  } catch (error) {
    alert(error.message);
  }
});
