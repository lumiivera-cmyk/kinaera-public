/**
 * Kinwriters and servers: the rail on the left, switching between kinwriters,
 * the kinwriter menu (name, avatar, colour, how they write; opened from their
 * page, js/kinwriter-self.js), making new kinwriters, and server settings.
 */

import { channelIcon, parseAddress, renderAll } from "./channels.js";
import { $, api, els, hideFormError, readLocal, showFormError, state, writeLocal } from "./core.js";
import { initial } from "./format.js";
import { seenMessages } from "./live.js";
import { createGroup, renderServerGroups } from "./groups.js";

// ------------------------------------------------------ kinwriters and servers

/*
 * Each kinwriter is their own space, with their own memory (src/hub.ts);
 * servers group them in the rail on the left. The page works on one
 * kinwriter at a time (`state.kinwriterId`): opening another kinwriter's channel,
 * or another server, switches to them.
 */

export const KINWRITER_KEY = "kinaera.friend";

/** The servers and their kinwriters (with each kinwriter's channels and news), from the hub. */
export async function loadHub() {
  try {
    const data = await api("GET", "/api/hub");
    state.hub = data.servers;
    state.archived = data.archived ?? [];
    state.together = data.together === true;
  } catch {
    state.hub = state.hub ?? [];
  }
}

const allKinwriters = () => (state.hub ?? []).flatMap((s) => s.friends.map((p) => ({ ...p, serverId: s.id })));
const currentServer = () => (state.hub ?? []).find((s) => s.friends.some((p) => p.id === state.kinwriterId)) ?? null;
const serverName = (server) => server.name || server.friends[0]?.name || "Server";

/** Which kinwriter to open: the address, then the last one you had open, then the first. */
export function pickKinwriter() {
  const friends = allKinwriters();
  const wanted = [parseAddress().kinwriterId, readLocal(KINWRITER_KEY)];
  return wanted.find((id) => id && friends.some((p) => p.id === id)) ?? friends[0]?.id ?? null;
}

/** Open another kinwriter (and one of their channels): the page starts over as theirs. */
export function switchKinwriter(kinwriterId, channelId = null) {
  writeLocal(KINWRITER_KEY, kinwriterId);
  const hash = `#/p/${encodeURIComponent(kinwriterId)}${channelId ? `/channel/${encodeURIComponent(channelId)}` : ""}`;
  history.replaceState(null, "", hash);
  location.reload();
}

/** An avatar: an emoji or an initial, in the kinwriter's colour. */
export function paintAvatar(element, { name, avatar, color }) {
  element.textContent = avatar || initial(name ?? "?");
  element.classList.toggle("emoji-avatar", Boolean(avatar));
  if (color >= 0) element.style.setProperty("--friend-hue", String(color));
  else element.style.removeProperty("--friend-hue");
  element.classList.toggle("colored-avatar", color >= 0);
}

/** Whether a kinwriter (not the open one) has news in any channel. */
function kinwriterHasNews(kinwriter) {
  const seen = seenMessages();
  return kinwriter.channels.some((c) => {
    const a = kinwriter.activity[c.id];
    return a && a.author === "friend" && c.id !== state.channelId && seen[c.id] !== a.lastId;
  });
}

/** The rail: one button per server, and + for a new one. */
export function renderRail() {
  const rail = $("server-rail");
  if (!rail || !state.hub) return;
  const current = currentServer();
  const buttons = state.hub.map((server) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "server-button";
    if (server === current) button.setAttribute("aria-current", "true");
    button.title = serverName(server);
    button.setAttribute("aria-label", serverName(server));
    const first = server.friends[0];
    const face = document.createElement("span");
    face.className = "avatar server-face";
    if (server.friends.length === 1 || !server.name) paintAvatar(face, first);
    else paintAvatar(face, { name: server.name, avatar: "", color: first?.color ?? -1 });
    button.append(face);
    if (server.friends.some((p) => p.id !== state.kinwriterId && kinwriterHasNews(p))) {
      const dot = document.createElement("span");
      dot.className = "server-unread";
      button.append(dot);
    }
    button.addEventListener("click", () => {
      if (server === current) return openServerSettings();
      const last = readLocal(`kinaera.friend.${server.id}`);
      switchKinwriter(server.friends.find((p) => p.id === last)?.id ?? first.id);
    });
    return button;
  });
  const add = document.createElement("button");
  add.type = "button";
  add.className = "server-button server-add";
  add.title = "New server, with a new kinwriter";
  add.setAttribute("aria-label", "New server");
  add.textContent = "+";
  add.addEventListener("click", () => openNewKinwriter(null));
  rail.replaceChildren(...buttons, add);
  $("server-name").textContent = current ? serverName(current) : "Kinaera";
  if (current) writeLocal(`kinaera.friend.${current.id}`, state.kinwriterId);
}

/**
 * In a server with several kinwriters, the sidebar shows each one's channels
 * under their name. The open kinwriter's are the real, draggable list; the
 * others' are links that switch to them.
 */
export function otherKinwriterItems() {
  const server = currentServer();
  if (!server || server.friends.length < 2) return { before: [], after: [], header: null };
  const index = server.friends.findIndex((p) => p.id === state.kinwriterId);
  const section = (kinwriter) => {
    const header = document.createElement("li");
    header.className = "friend-section";
    const face = document.createElement("span");
    face.className = "avatar";
    paintAvatar(face, kinwriter);
    const name = document.createElement("span");
    name.textContent = kinwriter.name;
    header.append(face, name);
    // Only the kinwriter in an orientation is unavailable meanwhile.
    if (kinwriter.orienting) header.append(Object.assign(document.createElement("span"), { className: "hint", textContent: " orienting" }));
    return header;
  };
  const items = (kinwriter) => {
    const categories = new Map(kinwriter.categories.map((c) => [c.id, c.position]));
    const order = (c) => [c.categoryId ? 1 + (categories.get(c.categoryId) ?? 0) : 0, c.position];
    return [...kinwriter.channels]
      .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])
      .map((channel) => {
        const item = document.createElement("li");
        item.className = "remote-channel";
        const link = document.createElement("a");
        link.className = "channel-link";
        link.href = `#/p/${encodeURIComponent(kinwriter.id)}/channel/${channel.id}`;
        link.draggable = false;
        const label = document.createElement("span");
        label.className = "channel-link-name";
        label.textContent = channel.name;
        link.append(channelIcon(channel.kind), label);
        const a = kinwriter.activity[channel.id];
        if (a && a.author === "friend" && seenMessages()[channel.id] !== a.lastId) {
          const dot = document.createElement("span");
          dot.className = "channel-unread";
          link.append(dot);
        }
        item.append(link);
        return item;
      });
  };
  const before = server.friends.slice(0, index).flatMap((p) => [section(p), ...items(p)]);
  const after = server.friends.slice(index + 1).flatMap((p) => [section(p), ...items(p)]);
  return { before, after, header: section({ ...server.friends[index], ...currentKinwriterLook(), orienting: state.orientation?.status === "running" }) };
}

const currentKinwriterLook = () => ({ name: state.settings.friendName, avatar: state.settings.friendAvatar, color: state.settings.friendColor });

// ------------------------------------------------------------ the kinwriter menu

export function openKinwriter() {
  const s = state.settings;
  const form = $("friend-form").elements;
  paintAvatar($("friend-dialog-avatar"), currentKinwriterLook());
  $("friend-dialog-title").textContent = s.friendName;
  form.friendName.value = s.friendName;
  form.friendAvatar.value = s.friendAvatar;
  form.themeColor.checked = s.friendColor < 0;
  form.friendColor.value = s.friendColor < 0 ? 260 : s.friendColor;
  form.friendColor.disabled = s.friendColor < 0;
  for (const key of ["friendPrompt", "literaryPrompt", "casualPrompt", "oocPrompt"]) form[key].value = s[key];
  form.oocBubbles.checked = s.oocBubbles;
  form.replyDelaySeconds.value = s.replyDelayMs / 1000;
  form.typingPerCharMs.value = s.typingPerCharMs;
  updateTextingOnly();
  $("surprise-result").textContent = "Reroll who they are from a few random ingredients. Nothing changes until you press Save.";
  $("friend-move").hidden = (currentServer()?.friends.length ?? 1) < 2;
  hideFormError($("friend-form"));
  $("friend-dialog").showModal();
}

async function saveKinwriter(event) {
  event.preventDefault();
  const form = $("friend-form").elements;
  try {
    const { settings, suggestion } = await api("PUT", "/api/settings", {
      friendName: form.friendName.value,
      friendAvatar: form.friendAvatar.value,
      friendColor: form.themeColor.checked ? -1 : Number(form.friendColor.value),
      friendPrompt: form.friendPrompt.value,
      literaryPrompt: form.literaryPrompt.value,
      casualPrompt: form.casualPrompt.value,
      oocPrompt: form.oocPrompt.value,
      oocBubbles: form.oocBubbles.checked,
      replyDelayMs: Math.round(Number(form.replyDelaySeconds.value) * 1000),
      typingPerCharMs: Number(form.typingPerCharMs.value),
    });
    state.settings = settings;
    $("friend-dialog").close();
    // A change to who they are is a suggestion, waiting for them.
    if (suggestion) alert(`Your change to who ${settings.friendName} is was sent as a suggestion: they'll accept or decline it on their next turn.`);
    await loadHub();
    renderAll();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

/** Show the texting numbers only when texting is on. */
function updateTextingOnly() {
  const form = $("friend-form");
  for (const element of form.querySelectorAll(".texting-only")) element.hidden = !form.elements.oocBubbles.checked;
}

/** The kinwriter menu's avatar follows what you type and pick. */
function previewKinwriterLook() {
  const form = $("friend-form").elements;
  form.friendColor.disabled = form.themeColor.checked;
  paintAvatar($("friend-dialog-avatar"), {
    name: form.friendName.value,
    avatar: form.friendAvatar.value.trim(),
    color: form.themeColor.checked ? -1 : Number(form.friendColor.value),
  });
}

/** Kinwriter menu → "Surprise me": reroll who they are, filled in but not saved. */
async function surpriseKinwriter() {
  const button = $("surprise-friend");
  const result = $("surprise-result");
  button.disabled = true;
  result.textContent = "Rolling…";
  try {
    const { name, prompt, seeds } = await api("POST", "/api/friend/random", {});
    const form = $("friend-form").elements;
    form.friendName.value = name;
    form.friendPrompt.value = prompt;
    previewKinwriterLook();
    result.textContent = `Meet ${name} (${seeds}). Press Save to keep them, or roll again.`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/**
 * Retire the open kinwriter (section 6.12): they get one last turn to leave a
 * note, then they're set aside, whole, until you restore them.
 */
async function archiveKinwriter() {
  const name = state.settings.friendName;
  if (!confirm(`Archive ${name}? They get one last turn to write a note, then they're set aside with everything they remember. You can restore them from server settings.`)) return;
  const button = $("friend-archive");
  button.disabled = true;
  button.textContent = `Saying goodbye…`;
  try {
    const { note } = await api("POST", `/api/hub/friends/${encodeURIComponent(state.kinwriterId)}/archive`, {});
    alert(note ? `${name} left a note:\n\n${note}` : `${name} didn't leave a note.`);
    writeLocal(KINWRITER_KEY, "");
    history.replaceState(null, "", location.pathname);
    location.reload();
  } catch (error) {
    showFormError($("friend-form"), error.message);
    button.disabled = false;
    button.textContent = "Archive…";
  }
}

async function deleteKinwriter() {
  const name = state.settings.friendName;
  if (!confirm(`Delete ${name} for good? Their notebook, channels and everything they remember go too. (Archiving keeps them instead.) Their files are kept in the data folder's trash, just in case.`)) return;
  if (prompt(`Type ${name} to confirm.`)?.trim() !== name) return;
  try {
    await api("DELETE", `/api/hub/friends/${encodeURIComponent(state.kinwriterId)}`, {});
    writeLocal(KINWRITER_KEY, "");
    history.replaceState(null, "", location.pathname);
    location.reload();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

/** Give the open kinwriter a server of their own. */
async function moveKinwriterOut() {
  try {
    await api("POST", `/api/hub/friends/${encodeURIComponent(state.kinwriterId)}/move`, {});
    await loadHub();
    $("friend-dialog").close();
    renderAll();
  } catch (error) {
    showFormError($("friend-form"), error.message);
  }
}

// -------------------------------------------------------- new kinwriters

/** A new kinwriter: in a new server (`serverId` null), or in that server. */
function openNewKinwriter(serverId) {
  state.newKinwriterServer = serverId;
  const form = $("new-friend-form");
  form.reset();
  const server = serverId && state.hub.find((s) => s.id === serverId);
  $("new-friend-title").textContent = server ? `A new kinwriter in ${serverName(server)}` : "New server";
  $("new-friend-note").textContent = server
    ? "Another kinwriter here, with their own notebook, channels and memory. Their channels show under their name."
    : "A new kinwriter, with a server of their own. They start fresh: their own notebook, channels and memory, with your connection profiles and preferences.";
  $("new-server-name-row").hidden = Boolean(server);
  $("new-friend-surprise-result").textContent = "";
  state.newKinwriterTastes = "";
  hideFormError(form);
  $("new-friend-dialog").showModal();
}

async function surpriseNewKinwriter() {
  const button = $("new-friend-surprise");
  const result = $("new-friend-surprise-result");
  button.disabled = true;
  result.textContent = "Rolling…";
  try {
    const { name, prompt, tastes, seeds } = await api("POST", "/api/friend/random", {});
    const form = $("new-friend-form").elements;
    form.name.value = name;
    form.prompt.value = prompt;
    state.newKinwriterTastes = tastes ?? "";
    result.textContent = `Meet ${name} (${seeds}). Roll again, or Create.`;
  } catch (error) {
    result.textContent = `✗ ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function createKinwriter(event) {
  event.preventDefault();
  const form = $("new-friend-form").elements;
  const body = { name: form.name.value, avatar: form.avatar.value, copyFrom: state.kinwriterId };
  if (form.prompt.value.trim()) body.prompt = form.prompt.value;
  // Tastes rolled with "Surprise me" (theirs to rewrite from then on).
  if (state.newKinwriterTastes) body.tastes = state.newKinwriterTastes;
  const button = $("new-friend-create");
  button.disabled = true;
  try {
    const serverId = state.newKinwriterServer;
    const data = serverId
      ? await api("POST", `/api/hub/servers/${encodeURIComponent(serverId)}/friends`, body)
      : await api("POST", "/api/hub/servers", { ...body, serverName: form.serverName.value });
    switchKinwriter(data.kinwriterId);
  } catch (error) {
    showFormError($("new-friend-form"), error.message);
    button.disabled = false;
  }
}

// ------------------------------------------------------------- servers

function openServerSettings() {
  const server = currentServer();
  if (!server) return;
  $("server-name-input").value = server.name;
  $("server-friend-list").replaceChildren(
    ...server.friends.map((kinwriter) => {
      const item = document.createElement("li");
      const face = document.createElement("span");
      face.className = "avatar";
      paintAvatar(face, kinwriter.id === state.kinwriterId ? currentKinwriterLook() : kinwriter);
      const name = document.createElement("span");
      name.textContent = kinwriter.id === state.kinwriterId ? `${kinwriter.name} (open)` : kinwriter.name;
      item.append(face, name);
      return item;
    }),
  );
  $("server-delete").hidden = state.hub.length < 2;
  renderServerGroups(server);
  renderArchived(server);
  hideFormError($("server-form"));
  $("server-dialog").showModal();
}

/** Archived kinwriters, each with their note: restore into this server, or delete for good. */
function renderArchived(server) {
  const archived = state.archived ?? [];
  $("archived-section").hidden = archived.length === 0;
  $("archived-list").replaceChildren(
    ...archived.map((kinwriter) => {
      const item = document.createElement("li");
      const face = document.createElement("span");
      face.className = "avatar";
      paintAvatar(face, kinwriter);
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = kinwriter.name;
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = kinwriter.note ? `“${kinwriter.note}”` : "No note.";
      text.append(name, note);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "link-button";
      restore.textContent = "Restore";
      restore.addEventListener("click", async () => {
        try {
          await api("POST", `/api/hub/friends/${encodeURIComponent(kinwriter.id)}/restore`, { serverId: server.id });
          switchKinwriter(kinwriter.id);
        } catch (error) {
          showFormError($("server-form"), error.message);
        }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button";
      remove.textContent = "Delete for good";
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete ${kinwriter.name} for good? Everything they remember goes. (Their files go to the data folder's trash.)`)) return;
        if (prompt(`Type ${kinwriter.name} to confirm.`)?.trim() !== kinwriter.name) return;
        try {
          const data = await api("DELETE", `/api/hub/friends/${encodeURIComponent(kinwriter.id)}`, {});
          state.archived = data.archived;
          renderArchived(server);
        } catch (error) {
          showFormError($("server-form"), error.message);
        }
      });
      item.append(face, text, restore, remove);
      return item;
    }),
  );
}

async function saveServer(event) {
  event.preventDefault();
  try {
    const data = await api("PATCH", `/api/hub/servers/${encodeURIComponent(currentServer().id)}`, { name: $("server-name-input").value });
    state.hub = data.servers;
    $("server-dialog").close();
    renderRail();
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

async function deleteServer() {
  const server = currentServer();
  const names = server.friends.map((p) => p.name).join(", ");
  if (!confirm(`Delete the server "${serverName(server)}", and ${names} with it? Everything they remember goes too. (Their files are kept in the data folder's trash.)`)) return;
  if (prompt(`Type ${serverName(server)} to confirm.`)?.trim() !== serverName(server)) return;
  try {
    await api("DELETE", `/api/hub/servers/${encodeURIComponent(server.id)}`, {});
    writeLocal(KINWRITER_KEY, "");
    history.replaceState(null, "", location.pathname);
    location.reload();
  } catch (error) {
    showFormError($("server-form"), error.message);
  }
}

$("open-friend-from-settings").addEventListener("click", () => {
  els.settingsDialog.close();
  openKinwriter();
});
$("friend-form").addEventListener("submit", saveKinwriter);
$("friend-form").addEventListener("input", previewKinwriterLook);
$("friend-form").elements.oocBubbles.addEventListener("change", updateTextingOnly);
$("surprise-friend").addEventListener("click", surpriseKinwriter);
$("friend-delete").addEventListener("click", deleteKinwriter);
$("friend-archive").addEventListener("click", archiveKinwriter);
$("friend-move").addEventListener("click", moveKinwriterOut);
$("new-friend-form").addEventListener("submit", createKinwriter);
$("new-friend-surprise").addEventListener("click", surpriseNewKinwriter);
$("server-name").addEventListener("click", openServerSettings);
$("server-form").addEventListener("submit", saveServer);
$("server-delete").addEventListener("click", deleteServer);
$("create-group").addEventListener("click", () => createGroup(currentServer().id));
$("server-add-friend").addEventListener("click", () => {
  $("server-dialog").close();
  openNewKinwriter(currentServer().id);
});
