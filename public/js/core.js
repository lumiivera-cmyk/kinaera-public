/**
 * The core of the web app: what every other module shares.
 *
 * - `state`: a copy of what's on screen. The server is always the source
 *   of truth; the browser never guesses what was saved, it shows what the
 *   server sends back.
 * - `$` and `els`: finding elements on the page.
 * - `api`: talking to the server.
 * - Showing errors, remembering small things in the browser, and reading
 *   files you pick.
 *
 * This module imports nothing, so it's always ready before any other
 * module runs.
 */

// ------------------------------------------------------------------ state

/** Everything the page is currently showing. */
export const state = {
  /**
   * The open kinwriter's settings: who they are and how they write
   * (kinwriterName, literaryPrompt, casualPrompt, oocPrompt, ...), their look
   * (appTheme), and Settings, which every kinwriter shares unless a section
   * is just theirs (`ownSettings`; src/universal.ts).
   */
  settings: null,
  /**
   * Every channel, in sidebar order: {id, name, kind, mode, pendingMode,
   * theme, position, cast}. `cast` is the entries pinned to it, as you see
   * them: {entryId, name, playedBy, owner, kind, hidden, proxyPrefix}.
   * `playedBy` is "user", "kinwriter" (your kinwriter) or "both" (shared characters).
   */
  channels: [],
  /**
   * Your kinwriter's own practice channel (src/orientation.ts), shown apart at
   * the bottom of the sidebar. You can read it, not write in it.
   */
  practice: null,
  /** Kinwriters together (Settings → Advanced): group channels, DMs, knowing about each other. */
  together: false,
  /** Presence: what they're doing in each busy channel ({id: "writing" | "reading"}), overall, and their own status. */
  phases: {},
  presence: "idle",
  status: null,
  /** The message your next one replies to (the Reply button): {channelId, messageId}, or null. */
  replyingTo: null,
  /** The open channel's voice marks and "not me" flags: {voice: [ids], notMe: {id: {note, profile}}}. */
  flags: { voice: [], notMe: {} },
  /** The open channel's branches you can go to, each at the message it follows (js/branches.js). */
  branches: [],
  /** Your suggestions for their identity and self-page still waiting for them: {identity, selfNotes}. */
  waiting: { identity: [], selfNotes: [] },
  /** Channel categories, in sidebar order: {id, name, position, collapsed}. */
  categories: [],
  /** Id of the open channel, or null if there are no channels. */
  channelId: null,
  /**
   * The notebook, as you see it: {folders, entries, suggestions, templates}.
   * Each entry carries its effective `settings`, what you may do with it
   * (`access`), and the channels it's pinned to (`pinnedIn`).
   */
  notebook: { folders: [], entries: [], suggestions: [], templates: { character: [], lore: [] } },
  /** The entry open in the entry editor, or a new one: {kind, owner} without an id. */
  editingEntry: null,
  /** The folder open in the folder dialog (null for a new one). */
  editingFolder: null,
  /** Connection profiles: {id, name, model, temperature, maxTokens, topP, minP, reasoningEffort, supportsTools, quirkPrompt, extraParams}. */
  profiles: [],
  /** Roulettes: {id, name, entries: [{profileId, weight}]}. */
  roulettes: [],
  /** The profile or roulette open in its editor (null for a new one). */
  editingProfile: null,
  editingRoulette: null,
  /** The open channel's tool calls (your kinwriter's actions), oldest first. */
  toolCalls: [],
  /** The open channel's reasoning from thinking models: {turnId, round, text, profile, model, createdAt}, oldest first. */
  reasoning: [],
  /** The open channel's comment threads: {id, messageId, quote, resolved, comments}. */
  threads: [],
  /** The open channel's summaries: {scenes, story, current, digest, running, error}. */
  summaries: null,
  /** Scene breaks whose scene summary is showing. */
  openSummaries: new Set(),
  /** The scene break whose summary is being edited, if any. */
  editingSummary: null,
  /** What your kinwriter asks of you and is waiting on: asks, and proposals like deleting a channel. */
  inbox: [],
  /** The full tool log of the open channel, while the tool log is open. */
  toolLog: [],
  /** Turn ids whose action details are expanded under their messages. */
  openActivity: new Set(),
  /** Turns whose reasoning is unfolded. */
  openReasoning: new Set(),
  /** Runs of quiet turns that are unfolded, by the run's first turn id. */
  openQuiet: new Set(),
  /** Notebook entries attached to the message you're writing, by channel id: a Set of entry ids. */
  attachments: new Map(),
  /** The comment thread open in the thread dialog, or a new comment: {messageId, quote}. */
  thread: null,
  /** Messages in the open channel: {id, channelId, author, content, characters, createdAt, editedAt?, model?}. */
  messages: [],
  /** Ids of channels where the kinwriter is writing right now. */
  busy: new Set(),
  /** Id of the message being edited, if any. */
  editingId: null,
  /** What "Try again" does after an error, or null if retrying makes no sense. */
  retry: null,
  /** Unsent text for each channel, so switching channels doesn't lose it. */
  drafts: new Map(),
  /** In casual channels: which of your characters you're posting as, by channel id. */
  postingAs: new Map(),
  /** Every theme: {id, name, description, builtIn, hasLite, swatch}. */
  themes: [],
  /**
   * Added to theme URLs (`?v=`). Bumped after you edit a theme, so the
   * browser fetches the new version.
   */
  themeVersion: 0,
  /** The theme open in the theme editor (with its css, liteCss and files). */
  editingTheme: null,
  /** Fingerprint of the app's files when this page loaded (see `checkForUpdate`). */
  appVersion: null,

  // Kinwriters and servers (js/kinwriter-page.js)
  /** Id of the kinwriter you're looking at; their API is under /p/<id> (see `scoped`). */
  kinwriterId: null,
  /** The hub's servers, each with its kinwriters and their news (null until loaded). */
  hub: null,
  /** Archived kinwriters. */
  archived: [],
  /** The server a new kinwriter is being made in (null: a new server). */
  newKinwriterServer: null,

  // From the server's state (js/live.js)
  /** Sections of Settings that are just this kinwriter's; the rest are shared. */
  ownSettings: [],
  /** Their self-notes: whether they share them with you (src/selfnotes.ts). */
  selfNotes: null,
  /** True after a fresh start, until you've made your new kinwriter (js/setup.js). */
  setup: false,
  /** Whether the developer panel is on (DEVELOPER_PANEL=1). */
  developerPanel: false,
  /** Their orientation: {status, session, step, ...} (js/orientation.js). */
  orientation: null,
  /** The server's message revision; when it changes, something new was written. */
  revision: null,
  /** Each channel's newest message: {channelId: {lastId, author}}, for unread dots. */
  activity: {},
  /** Custom emojis: {name, file}. */
  emojis: [],
  /** Whether phone notifications work on the server (Termux:API). */
  notifications: false,
  /** When the next heartbeat is due (ISO time), or null. */
  heartbeatNext: null,

  // The open channel, and what's going on in it
  /** Your suggested rewrites in the open channel (js/rewrites.js). */
  rewrites: [],
  /** A burst of texts being shown one at a time: {channelId, queue, timer} (js/texting.js). */
  reveal: null,
  /** Waiting for you to pause before your kinwriter answers your texts, and where. */
  replyTimer: 0,
  replyChannel: null,

  // The sidebar
  /** True while a channel or category is being dragged in the sidebar. */
  dragging: false,
  /** The category open in the category dialog (null for a new one), and what to do once one is made. */
  editingCategory: null,
  afterCategory: null,
};

// Shortcut for looking up elements by id.
export const $ = (id) => document.getElementById(id);

export const els = {
  app: $("app"),
  channelList: $("channel-list"),
  channelIndicator: Object.assign(document.createElement("li"), {
    className: "channel-indicator",
    ariaHidden: "true",
  }),
  kinwriterName: $("kinwriter-name"),
  kinwriterAvatar: $("kinwriter-avatar"),
  channelView: $("channel-view"),
  channelName: $("channel-name"),
  channelTitleIcon: $("channel-title-icon"),
  channelTopic: $("channel-topic"),
  messages: $("messages"),
  composer: $("composer"),
  status: $("status"),
  error: $("error"),
  errorText: $("error-text"),
  errorRetry: $("error-retry"),
  form: $("composer-form"),
  input: $("composer-input"),
  send: $("send-button"),
  turn: $("turn-button"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  channelDialog: $("channel-dialog"),
  channelForm: $("channel-form"),
  newChannelDialog: $("new-channel-dialog"),
  newChannelForm: $("new-channel-form"),
  promptDialog: $("prompt-dialog"),
  promptPreview: $("prompt-preview"),
  modelList: $("model-list"),
  loadModels: $("load-models"),
};

/** The open channel's full details, or undefined. */
export function currentChannel() {
  return state.channels.find((c) => c.id === state.channelId) ?? (state.practice?.id === state.channelId ? state.practice : undefined);
}

// ------------------------------------------------------------ server API

/**
 * Call the server's API and return the parsed JSON.
 *
 * Every request that sends data is marked as JSON; the server insists on it
 * (see `checkRequestIsFromTheApp` in src/server.ts). If the server answers
 * with an error, this throws an Error carrying the server's message.
 */
export async function api(method, path, body) {
  const response = await fetch(scoped(path), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (HTTP ${response.status})`);
    // The rest of the body, for errors that carry more (a seed's tries).
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * Each kinwriter is their own app on the server (src/hub.ts): their API is at
 * /p/<kinwriter>/api/..., and so are their custom emojis. The hub's own API
 * (/api/hub) and themes are shared.
 */
export function scoped(path) {
  if (!state.kinwriterId || path.startsWith("/api/hub")) return path;
  if (path.startsWith("/api/") || path.startsWith("/emojis/")) return `/p/${encodeURIComponent(state.kinwriterId)}${path}`;
  return path;
}

/** The API path for something in the open channel, e.g. channelPath("turn"). */
export function channelPath(suffix, channelId = state.channelId) {
  return `/api/channels/${encodeURIComponent(channelId)}/${suffix}`;
}

// ------------------------------------------------------------------ errors

/**
 * Show an error above the composer. `retry` is the function "Try again"
 * should call, or null to hide that button.
 */
export function showError(message, retry) {
  state.retry = retry;
  els.errorText.textContent = message;
  els.errorRetry.hidden = !retry;
  els.error.hidden = false;
}

export function hideError() {
  state.retry = null;
  els.error.hidden = true;
}

/** Show an error inside a dialog's form. */
export function showFormError(form, message) {
  const box = form.querySelector(".form-error");
  box.textContent = message;
  box.hidden = false;
}

export function hideFormError(form) {
  form.querySelector(".form-error").hidden = true;
}

/*
 * localStorage can be unavailable (private browsing, storage turned off),
 * so every use is wrapped: if it fails, Kinaera just forgets.
 */
export function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the setting just won't be remembered.
  }
}

/** A file's contents as base64 text (the "data:...;base64," prefix removed). */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(file);
  });
}
