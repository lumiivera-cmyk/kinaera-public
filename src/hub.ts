/**
 * The hub: several kinwriters, each with their own memory, grouped into
 * servers.
 *
 * A **kinwriter** is a whole Kinaera of their own: their own database and
 * folder, so their own notebook (and secrets), settings and prompts,
 * channels and messages, summaries, heartbeat, reference library,
 * custom emojis and logs. Nothing one kinwriter knows can reach
 * another, because nothing is shared: each is a separate app (`createApp`
 * in src/server.ts), exactly as Kinaera was with one kinwriter.
 *
 * A **server** is a group of kinwriters in the rail on the left. Usually a
 * server has one kinwriter (their own place, like a Discord server of your
 * own), but it can have several: its sidebar then shows each kinwriter's
 * channels under their name. Each channel belongs to one kinwriter.
 *
 * The hub keeps the list in `<dataDir>/hub.json`, runs one app per kinwriter,
 * and sends each request to the right one:
 *
 *   /p/<kinwriterId>/api/...   that kinwriter's API (and /p/<id>/emojis/...)
 *   /api/hub/...             the servers and kinwriters themselves (below)
 *   anything else            the first kinwriter's app (the web app's files,
 *                            themes, and the API for older pages)
 *
 * The very first kinwriter lives in the data folder itself. New kinwriters
 * live in `<dataDir>/kinwriters/<id>/`. Your own themes are shared by
 * everyone (`<dataDir>/themes`). A new kinwriter starts with a copy of your
 * connection profiles, roulettes and preferences (models, Jev, reaching
 * out, texting, the look), but not the old kinwriter's identity, prompts or
 * anything they remember.
 *
 * Deleting a kinwriter moves their files to `<dataDir>/trash/`, not away for
 * good, in case you change your mind.
 *
 * The Settings menu, and the connection profiles and roulettes, are shared
 * by every kinwriter (src/universal.ts): each keeps a copy, and the hub
 * keeps the copies the same. A kinwriter can have some sections of it
 * (models, memory, reaching out) just for themselves.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { listWording, setWording, setWordingOverrides } from "./wording.ts";
import { EnvFile, type EnvChange } from "./envfile.ts";
import { keepAwake } from "./notify.ts";
import { acceptedSeed, beginFromSeed, type Seed } from "./seeds.ts";
import { createApp, type App } from "./server.ts";
import { Groups, type HubGroup } from "./groups.ts";
import { defaultSettings, isShared, validateSettings } from "./store.ts";
import {
  browseKinwriter,
  browseMessages,
  closeBrowsing,
  describeFolder,
  exportKinwriter,
  folderPath,
  kinwriterDir,
  kinwriterNameIn,
  oldFolderNames,
  readBundle,
  renamedRegistry,
  startFresh,
  writeKinwriter,
  type KinwriterBundle,
} from "./datafolders.ts";
import { orientationRunning } from "./orientation.ts";
import type { Settings } from "./types.ts";
import { ASSIGNMENT_KEYS } from "./profiles.ts";
import {
  mergeProfiles,
  OWN_GROUPS,
  ownGroups,
  ownKeys,
  same,
  setOwnGroup,
  SETTING_GROUPS,
  syncProfiles,
  UNIVERSAL_KEYS,
  unionLines,
  type SettingGroup,
} from "./universal.ts";

export interface HubServer {
  id: string;
  /** Its name; "" shows its first kinwriter's name. */
  name: string;
  /** Its kinwriters' ids, in sidebar order. */
  kinwriters: string[];
}

export interface HubKinwriter {
  id: string;
  /** Their folder, relative to the data folder ("." for the first kinwriter). */
  dir: string;
  /**
   * Archived (retired, section 6.12): set aside with everything they
   * remember, and their last note. Not loaded until restored.
   */
  archived?: { at: string; note: string; name: string; avatar: string; color: number };
}

interface Registry {
  servers: HubServer[];
  kinwriters: HubKinwriter[];
  /** Group channels and DMs (src/groups.ts). */
  groups?: HubGroup[];
  /**
   * Kinwriters together (Settings → Labs, untested): group channels,
   * DMs, and kinwriters knowing about each other. Off (the default), each
   * kinwriter is on their own, even with several on one server.
   */
  together?: boolean;
  /**
   * The shared settings (src/universal.ts): what every kinwriter has, except
   * in sections that are their own. A hub from before settings were shared
   * doesn't have it yet: it's made on start, from the first kinwriter's.
   */
  settings?: Partial<Settings>;
}

/** Settings that are the kinwriter themselves: never copied to a new kinwriter. */
export const KINWRITER_KEYS: (keyof Settings)[] = [
  "kinwriterName",
  "kinwriterPrompt",
  "literaryPrompt",
  "casualPrompt",
  "oocPrompt",
  "kinwriterAvatar",
  "kinwriterColor",
  "kinwriterPronouns",
];

/** A kinwriter as the rail and sidebar show them, with their channels. */
export interface KinwriterSummary {
  id: string;
  name: string;
  avatar: string;
  color: number;
  channels: { id: string; name: string; kind: string; categoryId: string | null; position: number }[];
  categories: { id: string; name: string; position: number; collapsed: boolean }[];
  /** Each channel's newest message, for unread dots. */
  activity: Record<string, { lastId: string; author: string; at: string } | null>;
  busy: string[];
  /** In an orientation right now. */
  orienting: boolean;
}

export interface Hub {
  fetch: (request: Request) => Promise<Response>;
  /** Each kinwriter's app, by id. */
  apps: Map<string, App>;
  servers: () => HubServer[];
  /** Start every kinwriter's timers (summaries, heartbeat): `main()` does this. */
  start: () => void;
  /** Stop timers and close every database (tests). */
  close: () => void;
  /** Group channels and DMs (src/groups.ts). */
  groups: Groups;
}

class HubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createHub(config: Config, makeApp: (config: Config) => App = createApp): Hub {
  const root = config.dataDir;
  mkdirSync(root, { recursive: true });
  const registryPath = join(root, "hub.json");
  // Your edits to the prompts' wording (Settings → Prompts), for every kinwriter.
  setWordingOverrides(join(root, "prompts.json"));
  const apps = new Map<string, App>();
  let started = false;

  // ------------------------------------------------------------ the list

  // A hub.json from before the second rename is saved again under the new names.
  let renamed = false;
  function load(): Registry {
    if (!existsSync(registryPath)) return { kinwriters: [{ id: "home", dir: "." }], servers: [{ id: crypto.randomUUID(), name: "", kinwriters: ["home"] }] };
    const text = readFileSync(registryPath, "utf8");
    const registry = renamedRegistry<Registry>(JSON.parse(text));
    renamed = JSON.stringify(registry) !== JSON.stringify(JSON.parse(text));
    return registry;
  }
  const registry = load();
  if (moveOutOfFriends()) renamed = true;

  function save(): void {
    // Written whole, then renamed over the old one: never half-written.
    const temp = `${registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2));
    renameSync(temp, registryPath);
  }
  if (!existsSync(registryPath) || renamed) save();

  /**
   * Kinwriters' folders were in `friends/` before the second rename
   * (docs/orientation-1.md): each moves to `kinwriters/`, before any is
   * opened. Their new places are saved after; a start that stopped in
   * between finds the folder already moved, or moves it then. True if
   * anything changed.
   */
  function moveOutOfFriends(): boolean {
    let changed = false;
    for (const kinwriter of registry.kinwriters) {
      const old = /^friends[\\/]([^\\/]+)$/.exec(kinwriter.dir);
      if (!old) continue;
      const from = join(root, "friends", old[1]!);
      const to = join(root, "kinwriters", old[1]!);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(join(root, "kinwriters"), { recursive: true });
        renameSync(from, to);
      }
      kinwriter.dir = join("kinwriters", old[1]!);
      changed = true;
    }
    // The old folder goes once it's empty.
    const friends = join(root, "friends");
    if (existsSync(friends) && readdirSync(friends).length === 0) rmdirSync(friends);
    return changed;
  }

  // Group channels and DMs: shared by several kinwriters, so kept here.
  const groups = new Groups(() => (registry.groups ??= []), apps, save, config.groupDelayMs);

  /** The server a kinwriter is in. */
  const serverOf = (kinwriterId: string) => registry.servers.find((s) => s.kinwriters.includes(kinwriterId));

  function open(kinwriter: HubKinwriter): App {
    const app = makeApp({
      ...config,
      dataDir: resolve(root, kinwriter.dir),
      userThemesDir: join(root, "themes"),
      userBackgroundsDir: join(root, "backgrounds"),
      kinwriterId: kinwriter.id,
      example: kinwriter.id === "home" ? "generate" : false,
      // Who else is on their server (names only), only with kinwriters together.
      peers: () => {
        if (!registry.together) return [];
        const server = registry.servers.find((s) => s.kinwriters.includes(kinwriter.id));
        return (server?.kinwriters ?? [])
          .filter((id) => id !== kinwriter.id && apps.has(id))
          .map((id) => ({ id, name: apps.get(id)!.store.getSettings().kinwriterName }));
      },
      groups: {
        info: (channelId) => groups.info(kinwriter.id, channelId),
        dmWith: (peerId) => {
          const server = serverOf(kinwriter.id);
          if (!server || !server.kinwriters.includes(peerId)) throw new HubError(400, "They aren't on your server.");
          return groups.dm(server.id, kinwriter.id, peerId).id;
        },
      },
    });
    // With kinwriters kept apart, group channels and DMs are out of sight (kept, not deleted).
    app.store.hideShared = () => !registry.together;
    // What happens in a group channel's copy here is mirrored to the others.
    app.store.onMessageEvent = (event, message) => groups.onEvent(kinwriter.id, event, message);
    apps.set(kinwriter.id, app);
    if (started) startApp(app);
    return app;
  }
  for (const kinwriter of registry.kinwriters) if (!kinwriter.archived) open(kinwriter);

  // ---------------------------------------------------- shared settings

  const pick = (settings: Partial<Settings>, keys: readonly (keyof Settings)[]): Partial<Settings> =>
    Object.fromEntries(keys.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));

  /** Give a kinwriter the shared settings, except in their own sections. */
  function applyShared(app: App): void {
    const own = ownKeys(app.store);
    app.store.updateSettings(pick(registry.settings ?? {}, UNIVERSAL_KEYS.filter((k) => !own.has(k))));
  }

  /**
   * Bring a kinwriter into the shared settings (on the first start since
   * settings were shared, or imported, or restored), changing nothing about
   * how they write: their profiles and roulettes join the shared ones
   * (`mergeProfiles`), a section where their settings differ becomes their
   * own, and their hard limits join everyone's (none is dropped).
   * `others` are the kinwriters already sharing; the first kinwriter in
   * becomes what everyone shares.
   */
  function adopt(app: App, others: App[]): string[] {
    const [shared] = others;
    if (shared) {
      mergeProfiles(shared.store.db, app.store.db, app.store.getSettings().kinwriterName);
      for (const other of [...others.slice(1), app]) syncProfiles(shared.store.db, other.store.db);
    }
    const settings = app.store.getSettings();
    if (!registry.settings) {
      registry.settings = pick(settings, UNIVERSAL_KEYS);
      return [];
    }
    for (const group of OWN_GROUPS) {
      if (SETTING_GROUPS[group].some((k) => registry.settings![k] !== undefined && !same(settings[k], registry.settings![k]))) {
        setOwnGroup(app.store, group, true);
      }
    }
    const limits = unionLines(registry.settings.hardLimits ?? "", settings.hardLimits);
    if (limits !== (registry.settings.hardLimits ?? "")) {
      registry.settings.hardLimits = limits;
      for (const other of others) other.store.updateSettings({ hardLimits: limits });
    }
    applyShared(app);
    return ownGroups(app.store);
  }

  /** Every kinwriter in sidebar order: the first server's first kinwriter first. */
  const inOrder = () => registry.servers.flatMap((s) => s.kinwriters).flatMap((id) => (apps.has(id) ? [apps.get(id)!] : []));

  // A hub from before settings were shared: everyone's become one set, from the first kinwriter's.
  if (!registry.settings) {
    const sharing: App[] = [];
    for (const app of inOrder()) {
      const own = adopt(app, sharing);
      if (sharing.length && own.length) console.log(`[hub] settings are shared now; kept just for ${app.store.getSettings().kinwriterName}: ${own.join(", ")}`);
      sharing.push(app);
    }
    save();
  } else {
    // A setting added since settings were shared: shared from the first
    // kinwriter who doesn't keep that section as their own (or the default).
    // Anyone else who had it different keeps theirs, as their own section
    // (the look, which each kinwriter used to have for themselves).
    const missing = UNIVERSAL_KEYS.filter((k) => registry.settings![k] === undefined);
    if (missing.length) {
      const defaults = defaultSettings();
      const shared = registry.settings as Record<string, unknown>;
      for (const k of missing) shared[k] = inOrder().find((app) => !ownKeys(app.store).has(k))?.store.getSettings()[k] ?? defaults[k];
      for (const app of inOrder()) {
        const settings = app.store.getSettings();
        const own = ownKeys(app.store);
        for (const group of OWN_GROUPS) {
          const added = SETTING_GROUPS[group].filter((k) => missing.includes(k) && !own.has(k));
          if (added.some((k) => !same(settings[k], shared[k]))) {
            setOwnGroup(app.store, group, true);
            console.log(`[hub] ${group} is shared now; kept just for ${settings.kinwriterName}`);
          }
        }
      }
      save();
    }
  }

  /** Ask a kinwriter's app to change settings, as saving Settings does (so the heartbeat and summaries catch up). */
  async function putSettings(app: App, update: Partial<Settings>): Promise<void> {
    if (Object.keys(update).length === 0) return;
    const response = await app.fetch(
      new Request("http://localhost/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) }),
    );
    if (!response.ok) console.error(`[hub] couldn't share settings with ${app.store.getSettings().kinwriterName}: ${await response.text()}`);
  }

  /**
   * Settings were saved while looking at one kinwriter: everyone shares the
   * change, unless it's in a section that's that kinwriter's own (then it's
   * just theirs), and except anyone who has that section as their own.
   * One save is shared at a time, so two at once can't leave kinwriters
   * disagreeing.
   */
  let spreading: Promise<void> = Promise.resolve();
  function spreadSettings(sourceId: string, keys: string[]): Promise<void> {
    const next = spreading.then(() => spreadNow(sourceId, keys));
    spreading = next.catch(() => {});
    return next;
  }

  async function spreadNow(sourceId: string, keys: string[]): Promise<void> {
    const source = apps.get(sourceId);
    if (!source || !registry.settings) return;
    const own = ownKeys(source.store);
    const settings = source.store.getSettings();
    const changed = UNIVERSAL_KEYS.filter((k) => keys.includes(k) && !own.has(k) && !same(settings[k], registry.settings![k]));
    if (changed.length === 0) return;
    Object.assign(registry.settings, pick(settings, changed));
    save();
    for (const [id, app] of apps) {
      if (id === sourceId) continue;
      const theirs = ownKeys(app.store);
      await putSettings(app, pick(settings, changed.filter((k) => !theirs.has(k))));
    }
  }

  /** Profiles or roulettes changed while looking at one kinwriter: everyone gets the same. */
  function spreadProfiles(sourceId: string): void {
    const source = apps.get(sourceId);
    if (!source) return;
    for (const [id, app] of apps) if (id !== sourceId) syncProfiles(source.store.db, app.store.db);
    // Shared choices of something deleted go back to the default, as each kinwriter's did.
    let changed = false;
    for (const key of ASSIGNMENT_KEYS) {
      const value = registry.settings?.[key];
      if (!value) continue;
      try {
        source.store.profiles.checkAssignment(value);
      } catch {
        registry.settings![key] = "";
        changed = true;
      }
    }
    if (changed) save();
  }

  /** Send a request to a kinwriter's app; settings, profiles and the look it changes are shared with everyone. */
  async function forward(id: string, app: App, request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const settings = request.method === "PUT" && path === "/api/settings";
    const profiles = request.method !== "GET" && /^\/api\/(profiles|roulettes)(\/[^/]+)?$/.test(path);
    let keys: string[] = [];
    if (settings) {
      const sent = (await request
        .clone()
        .json()
        .catch(() => null)) as unknown;
      if (typeof sent === "object" && sent !== null) keys = Object.keys(sent);
    }
    // A new picture is shown straight away, which changes the look.
    if (request.method === "POST" && path === "/api/backgrounds") keys = ["appBackground"];
    const gone = request.method === "DELETE" ? path.match(/^\/api\/(themes|backgrounds)\/([^/]+)$/) : null;
    const response = await app.fetch(request);
    if (response.ok && keys.length) await spreadSettings(id, keys);
    if (response.ok && profiles) spreadProfiles(id);
    if (response.ok && gone) forgetLook(gone[1] as "themes" | "backgrounds", decodeURIComponent(gone[2]!));
    return response;
  }

  /**
   * A theme or background picture was deleted (they're everyone's): no
   * kinwriter shows it any more, whether the look is shared or their own.
   */
  function forgetLook(kind: "themes" | "backgrounds", name: string): void {
    for (const app of apps.values()) {
      if (kind === "themes") app.store.forgetTheme(name);
      else if (app.store.getSettings().appBackground === name) app.store.updateSettings({ appBackground: "" });
    }
    const shared = registry.settings;
    if (!shared) return;
    if (kind === "themes") {
      if (shared.appTheme === name) shared.appTheme = "classic";
      if (shared.themeOptions?.[name]) {
        const { [name]: _gone, ...rest } = shared.themeOptions;
        shared.themeOptions = rest;
      }
    } else if (shared.appBackground === name) shared.appBackground = "";
    save();
  }

  function startApp(app: App): void {
    app.summarizer.scheduleAll(15_000);
    app.heartbeat.start();
    app.rhythms.start();
    app.started();
    if (app.store.getSettings().heartbeatHours > 0) keepAwake();
  }

  function stopApp(app: App): void {
    app.heartbeat.stop();
    app.rhythms.stop();
    app.wakeups.stopReviews();
    app.summarizer.stop();
    app.stop();
  }

  const defaultApp = () => apps.get(registry.servers[0]!.kinwriters[0]!)!;
  const server = (id: string) => {
    const found = registry.servers.find((s) => s.id === id);
    if (!found) throw new HubError(404, "There's no such server.");
    return found;
  };
  const kinwriterApp = (id: string) => {
    const app = apps.get(id);
    if (!app) throw new HubError(404, "There's no such kinwriter.");
    return app;
  };

  // --------------------------------------------------------- summaries

  function summary(id: string): KinwriterSummary {
    const { store, kinwriter } = kinwriterApp(id);
    const settings = store.getSettings();
    // Group channels and DMs are listed with the server, not each kinwriter.
    const channels = store.listChannels().filter((c) => !isShared(c));
    return {
      id,
      name: settings.kinwriterName,
      avatar: settings.kinwriterAvatar,
      color: settings.kinwriterColor,
      channels: channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind, categoryId: c.categoryId, position: c.position })),
      categories: store.listCategories().map((c) => ({ id: c.id, name: c.name, position: c.position, collapsed: c.collapsed })),
      activity: Object.fromEntries(
        channels.map((c) => {
          const last = store.lastMessage(c.id);
          return [c.id, last ? { lastId: last.id, author: last.author, at: last.createdAt } : null];
        }),
      ),
      busy: kinwriter.busyChannels(),
      // In an orientation: only this kinwriter is unavailable meanwhile.
      orienting: orientationRunning(store) !== null,
    };
  }

  /** A server's group channels and DMs, as the sidebar and server settings show them. */
  function groupViews(serverId: string) {
    return (registry.groups ?? [])
      .filter((g) => g.serverId === serverId)
      .map((g) => {
        // Its newest message and who's writing there, from any member's copy.
        const copies = g.kinwriters.map((id) => apps.get(id)).filter((a): a is App => a !== undefined && a.store.hasChannel(g.id));
        const last = g.visible || g.kind === "group" ? copies[0]?.store.lastMessage(g.id) : undefined;
        return {
          id: g.id,
          kind: g.kind,
          name: g.kind === "dm" ? g.kinwriters.map((id) => apps.get(id)?.store.getSettings().kinwriterName ?? "?").join(" & ") : g.name,
          kinwriters: g.kinwriters,
          visible: g.kind === "group" || g.visible,
          activity: last ? { lastId: last.id, author: last.author, at: last.createdAt } : null,
          writing: copies.filter((a) => a.kinwriter.isBusy(g.id)).map((a) => a.store.getSettings().kinwriterName),
        };
      });
  }

  function view() {
    return {
      servers: registry.servers.map((s) => ({ ...s, kinwriters: s.kinwriters.map(summary), groups: registry.together ? groupViews(s.id) : [] })),
      together: registry.together === true,
      // Retired kinwriters, with the note they left.
      archived: registry.kinwriters.filter((f) => f.archived).map((f) => ({ id: f.id, ...f.archived! })),
    };
  }

  // ------------------------------------------------------- new kinwriters

  /** Make a kinwriter, copying profiles and preferences from another. */
  function makeKinwriter(input: Record<string, unknown>): string {
    const source = kinwriterApp(typeof input.copyFrom === "string" ? input.copyFrom : registry.servers[0]!.kinwriters[0]!);
    // From a seed (src/seeds.ts): checked before anything is made.
    let seed: Seed | null = null;
    if (input.seed !== undefined) {
      try {
        seed = acceptedSeed(input.seed);
      } catch (error) {
        throw new HubError(400, (error as Error).message);
      }
      input = { ...input, name: seed.header.name };
      delete input.prompt;
    }
    const identity = validateSettings({
      kinwriterName: input.name ?? "New kinwriter",
      ...(input.prompt !== undefined ? { kinwriterPrompt: input.prompt } : {}),
      ...(input.avatar !== undefined ? { kinwriterAvatar: input.avatar } : {}),
      ...(input.color !== undefined ? { kinwriterColor: input.color } : {}),
    });
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const kinwriter: HubKinwriter = { id, dir: join("kinwriters", id) };
    const app = open(kinwriter);
    try {
      syncProfiles(source.store.db, app.store.db);
      const preferences = Object.fromEntries(
        Object.entries(source.store.getSettings()).filter(([key]) => !KINWRITER_KEYS.includes(key as keyof Settings)),
      );
      app.store.updateSettings({ ...(preferences as Partial<Settings>), ...identity });
      // The shared settings, not what was just the other kinwriter's own.
      applyShared(app);
      // Who they were made as is the first version of their identity, which
      // is theirs from now on (src/identity.ts). Their first turn is the
      // orientation their store queued (src/orientation.ts).
      if (seed) beginFromSeed(app.store, seed, id);
      else app.store.identity.begin(identity.kinwriterPrompt ?? app.store.getSettings().kinwriterPrompt, typeof input.tastes === "string" ? input.tastes : "");
    } catch (error) {
      unmake(kinwriter);
      throw error;
    }
    // Opened before their settings were copied: keep the phone awake for their heartbeat too.
    if (started && app.store.getSettings().heartbeatHours > 0) keepAwake();
    if (started) void app.rhythms.tick();
    registry.kinwriters.push(kinwriter);
    return id;
  }

  /** A kinwriter whose making failed partway: their app stopped, their brand-new folder gone. */
  function unmake(kinwriter: HubKinwriter): void {
    const app = apps.get(kinwriter.id);
    if (app) stopApp(app);
    apps.delete(kinwriter.id);
    rmSync(resolve(root, kinwriter.dir), { recursive: true, force: true });
  }

  // ------------------------------------------------------------- routes

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
      throw new HubError(415, "API requests that change data must be sent as JSON.");
    }
    try {
      const value = await request.json();
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new HubError(400, "The request body must be a JSON object.");
    }
  }

  // ------------------------------------------------------ data folders

  /** A kinwriter from an exported file, or an old folder: a new kinwriter, on a server of their own. */
  function importKinwriter(bundle: KinwriterBundle): string {
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const entry: HubKinwriter = { id, dir: join("kinwriters", id) };
    writeKinwriter(resolve(root, entry.dir), bundle);
    // Opening upgrades their database to the current layout.
    const others = inOrder();
    try {
      adopt(open(entry), others);
    } catch (error) {
      unmake(entry);
      throw error;
    }
    registry.kinwriters.push(entry);
    registry.servers.push({ id: crypto.randomUUID(), name: "", kinwriters: [id] });
    save();
    return id;
  }

  /** Set everything aside and start over, from inside the app (what `bun run fresh` does). */
  function freshFromApp(): { aside: string; profiles: number } {
    closeBrowsing();
    groups.stop();
    for (const app of apps.values()) stopApp(app);
    apps.clear();
    let result: ReturnType<typeof startFresh> | null = null;
    let failed: unknown = null;
    try {
      result = startFresh(root, { kinwriterKeys: KINWRITER_KEYS });
    } catch (error) {
      // Nothing was set aside (the list is still here): everyone back, as they were.
      if (existsSync(registryPath)) {
        for (const kinwriter of registry.kinwriters) if (!kinwriter.archived) open(kinwriter);
        throw error;
      }
      // Set aside, but the new start didn't finish: the new hub opens anyway (so the app works), then the error.
      failed = error;
    }
    // A new hub: one kinwriter to make, on one server, kept apart.
    registry.kinwriters = [{ id: "home", dir: "." }];
    registry.servers = [{ id: crypto.randomUUID(), name: "", kinwriters: ["home"] }];
    registry.groups = [];
    delete registry.together;
    // Their settings (carried over by startFresh) are what's shared now.
    delete registry.settings;
    setWordingOverrides(join(root, "prompts.json"));
    mkdirSync(root, { recursive: true });
    adopt(open(registry.kinwriters[0]!), []);
    save();
    if (!result) throw failed;
    return result;
  }

  async function devRoute(request: Request, parts: string[]): Promise<Response> {
    const method = request.method;
    const plain = (fn: () => unknown) => {
      try {
        return fn();
      } catch (error) {
        if (error instanceof HubError) throw error;
        throw new HubError(400, error instanceof Error ? error.message : String(error));
      }
    };
    if (method === "GET" && parts.length === 1 && parts[0] === "folders") {
      // The current kinwriters by the names the app gives them (a name never saved is the default one).
      const current = plain(() => describeFolder(root, "current")) as ReturnType<typeof describeFolder>;
      for (const k of current.kinwriters) {
        const live = apps.get(k.id)?.store.getSettings();
        if (live) Object.assign(k, { name: live.kinwriterName, avatar: live.kinwriterAvatar });
      }
      return json({ current, old: oldFolderNames(root).map((name) => plain(() => describeFolder(root, name))) });
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "fresh") {
      const { aside, profiles } = plain(() => freshFromApp()) as { aside: string; profiles: number };
      console.log(`[hub] started fresh; the old folder is ${aside}`);
      return json({ aside: basename(aside), profiles, ...view() });
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "import") {
      // An exported kinwriter file, sent as it is.
      const input = await body(request);
      const kinwriterId = plain(() => importKinwriter(readBundle(input))) as string;
      return json({ kinwriterId, ...view() });
    }
    if (parts[0] === "folders" && parts[2] === "kinwriters" && parts[3]) {
      const folder = decodeURIComponent(parts[1]!);
      const id = decodeURIComponent(parts[3]);
      const path = plain(() => folderPath(root, folder)) as string;
      const dir = plain(() => kinwriterDir(path, id)) as string;
      // A current kinwriter's open database, for a consistent copy of it.
      const open = folder === "current" ? apps.get(id)?.store.db : undefined;
      if (method === "GET" && parts.length === 4) return json(plain(() => browseKinwriter(root, folder, id, open)));
      if (method === "GET" && parts.length === 6 && parts[4] === "channels") {
        const before = new URL(request.url).searchParams.get("before") ?? undefined;
        return json(plain(() => browseMessages(root, folder, id, decodeURIComponent(parts[5]!), before, undefined, open)));
      }
      if (method === "GET" && parts.length === 5 && parts[4] === "export") {
        // The current kinwriter's database is open: a snapshot of it, as it is now.
        const live = folder === "current" ? apps.get(id) : undefined;
        const name = live ? live.store.getSettings().kinwriterName : kinwriterNameIn(root, folder, id);
        const bundle = plain(() => exportKinwriter(dir, name, live?.store.db)) as KinwriterBundle;
        const file = `${name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "kinwriter"}.kinwriter.json`;
        return new Response(JSON.stringify(bundle), {
          headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${file}"` },
        });
      }
      if (method === "POST" && parts.length === 5 && parts[4] === "import") {
        if (folder === "current") throw new HubError(400, "They're already here.");
        const name = kinwriterNameIn(root, folder, id);
        const kinwriterId = plain(() => importKinwriter(exportKinwriter(dir, name))) as string;
        return json({ kinwriterId, ...view() });
      }
    }
    throw new HubError(404, "No such API route.");
  }

  function removeKinwriterFiles(kinwriter: HubKinwriter): void {
    const trash = join(root, "trash", `${kinwriter.id}-${Date.now()}`);
    mkdirSync(trash, { recursive: true });
    if (kinwriter.dir === ".") {
      // The first kinwriter lives in the data folder itself: move just their files.
      for (const name of ["kinaera.db", "kinaera.db-wal", "kinaera.db-shm", "emojis"]) {
        if (existsSync(join(root, name))) renameSync(join(root, name), join(trash, name));
      }
    } else {
      renameSync(resolve(root, kinwriter.dir), join(trash, "files"));
    }
  }

  /** Remove a kinwriter from everywhere; their files go to the trash. */
  function deleteKinwriter(id: string): void {
    const kinwriter = registry.kinwriters.find((p) => p.id === id);
    if (!kinwriter) throw new HubError(404, "There's no such kinwriter.");
    if (!kinwriter.archived && registry.kinwriters.filter((p) => !p.archived).length === 1) {
      throw new HubError(400, "You need at least one kinwriter, so the last one can't be deleted.");
    }
    if (!kinwriter.archived) {
      stopApp(kinwriterApp(id));
      apps.delete(id);
    }
    removeKinwriterFiles(kinwriter);
    registry.kinwriters = registry.kinwriters.filter((p) => p.id !== id);
    groups.kinwriterGone(id);
    for (const s of registry.servers) s.kinwriters = s.kinwriters.filter((p) => p !== id);
    registry.servers = registry.servers.filter((s) => s.kinwriters.length > 0);
  }

  async function hubRoute(request: Request, path: string): Promise<Response> {
    const method = request.method;
    const parts = path.split("/").slice(3); // after /api/hub
    if (method === "GET" && parts.length === 0) return json(view());

    // The prompts' wording (defaults/), with your edits: shared by every kinwriter.
    if (parts[0] === "prompts") {
      if (method === "GET" && parts.length === 1) return json({ files: listWording() });
      if ((method === "PUT" || method === "DELETE") && parts.length === 3) {
        const [file, section] = [decodeURIComponent(parts[1]!), decodeURIComponent(parts[2]!)];
        let text: string | null = null;
        if (method === "PUT") {
          const input = await body(request);
          if (typeof input.text !== "string" || input.text.length > 100_000) throw new HubError(400, "The wording must be text, 100,000 characters at most.");
          text = input.text;
        }
        try {
          setWording(file, section, text);
        } catch (error) {
          throw new HubError(400, error instanceof Error ? error.message : String(error));
        }
        return json({ files: listWording() });
      }
    }

    // Your .env file (Settings → API key and setup): used after a restart.
    if (parts[0] === "env" && parts.length === 1 && config.envPath) {
      const env = new EnvFile(config.envPath, config);
      if (method === "GET") return json(env.view());
      if (method === "PUT") {
        const input = await body(request);
        try {
          return json(env.save({ values: input.values as EnvChange["values"], apiKey: input.apiKey as string | undefined }));
        } catch (error) {
          throw new HubError(400, error instanceof Error ? error.message : String(error));
        }
      }
    }

    // Data folders (developer panel only, for now): start fresh, and the old folders' kinwriters.
    if (parts[0] === "dev") {
      if (!config.developerPanel) throw new HubError(404, "No such API route.");
      return await devRoute(request, parts.slice(1));
    }

    if (parts[0] === "servers") {
      if (method === "POST" && parts.length === 1) {
        // A new server, with a new kinwriter of its own.
        const input = await body(request);
        const kinwriterId = makeKinwriter(input);
        const created: HubServer = { id: crypto.randomUUID(), name: typeof input.serverName === "string" ? input.serverName.trim().slice(0, 100) : "", kinwriters: [kinwriterId] };
        registry.servers.push(created);
        save();
        return json({ server: created, kinwriterId, ...view() });
      }
      if (method === "PUT" && parts[1] === "order") {
        const ids = (await body(request)).ids;
        if (!Array.isArray(ids) || ids.length !== registry.servers.length || !registry.servers.every((s) => ids.includes(s.id))) {
          throw new HubError(400, "The new order must list every server exactly once.");
        }
        registry.servers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        save();
        return json(view());
      }
      const target = server(parts[1] ?? "");
      if (method === "PATCH" && parts.length === 2) {
        const input = await body(request);
        if (input.name !== undefined) {
          if (typeof input.name !== "string" || input.name.length > 100) throw new HubError(400, "A server's name is text, 100 characters at most.");
          target.name = input.name.trim();
        }
        if (input.kinwriters !== undefined) {
          // Reorder its kinwriters.
          const ids = input.kinwriters;
          if (!Array.isArray(ids) || ids.length !== target.kinwriters.length || !target.kinwriters.every((p) => ids.includes(p))) {
            throw new HubError(400, "kinwriters must list the server's kinwriters, in the new order.");
          }
          target.kinwriters = ids as string[];
        }
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "kinwriters" && parts.length === 3) {
        // Another kinwriter in this server.
        const kinwriterId = makeKinwriter(await body(request));
        target.kinwriters.push(kinwriterId);
        save();
        return json({ kinwriterId, ...view() });
      }
      if (method === "DELETE" && parts.length === 2) {
        if (registry.servers.length === 1) throw new HubError(400, "You need at least one server, so the last one can't be deleted.");
        // (A server lists only kinwriters who aren't archived.)
        if (registry.kinwriters.filter((f) => !f.archived).length === target.kinwriters.length) throw new HubError(400, "That would delete every kinwriter.");
        for (const id of [...target.kinwriters]) deleteKinwriter(id);
        registry.servers = registry.servers.filter((s) => s.id !== target.id);
        save();
        return json(view());
      }
    }

    // Hub-wide options (Settings → Labs).
    if (parts[0] === "options" && parts.length === 1 && method === "PATCH") {
      const input = await body(request);
      if (input.together !== undefined) {
        if (typeof input.together !== "boolean") throw new HubError(400, '"together" is true or false.');
        registry.together = input.together;
        save();
        console.log(`[hub] kinwriters together: ${input.together ? "on" : "off"}`);
      }
      return json(view());
    }

    // Group channels and DMs (src/groups.ts), only with kinwriters together.
    if ((parts[0] === "servers" && parts[2] === "groups") || parts[0] === "groups") {
      if (!registry.together) throw new HubError(400, "Group channels and DMs need Kinwriters together, under Settings → Labs.");
    }
    if (parts[0] === "servers" && parts[2] === "groups" && method === "POST") {
      const target = server(parts[1] ?? "");
      const input = await body(request);
      const name = typeof input.name === "string" ? input.name.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 100) : "";
      if (!name) throw new HubError(400, "A group channel needs a name.");
      const kinwriters = input.kinwriters;
      if (!Array.isArray(kinwriters) || new Set(kinwriters).size !== kinwriters.length || kinwriters.length < 2 || !kinwriters.every((f) => typeof f === "string" && target.kinwriters.includes(f))) {
        throw new HubError(400, "A group channel needs two or more kinwriters from this server.");
      }
      const group = groups.create("group", target.id, kinwriters as string[], name);
      return json({ group, ...view() });
    }
    if (parts[0] === "groups" && parts[1]) {
      const group = groups.get(parts[1]);
      if (!group) throw new HubError(404, "There's no such group channel.");
      if (method === "PATCH" && parts.length === 2) {
        const input = await body(request);
        if (input.name !== undefined) {
          if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new HubError(400, "A name is text, 100 characters at most.");
          groups.rename(group.id, input.name.trim().toLowerCase().replace(/\s+/g, "-"));
        }
        if (input.visible !== undefined) {
          if (typeof input.visible !== "boolean" || group.kind !== "dm") throw new HubError(400, '"visible" is true or false, for DMs.');
          group.visible = input.visible;
          save();
        }
        return json(view());
      }
      if (method === "DELETE" && parts.length === 2) {
        groups.remove(group.id);
        return json(view());
      }
    }

    if (parts[0] === "kinwriters" && parts[1]) {
      const id = parts[1];
      const entry = registry.kinwriters.find((f) => f.id === id);
      if (!entry) throw new HubError(404, "There's no such kinwriter.");
      if (method === "DELETE" && parts.length === 2) {
        deleteKinwriter(id);
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "archive" && !entry.archived) {
        // Retire them: one last turn for a note, then set aside, whole.
        if (registry.kinwriters.filter((f) => !f.archived).length === 1) throw new HubError(400, "You need at least one kinwriter who isn't archived.");
        const app = kinwriterApp(id);
        const note = await app.farewell();
        const settings = app.store.getSettings();
        entry.archived = { at: new Date().toISOString(), note, name: settings.kinwriterName, avatar: settings.kinwriterAvatar, color: settings.kinwriterColor };
        stopApp(app);
        apps.delete(id);
        for (const s of registry.servers) s.kinwriters = s.kinwriters.filter((p) => p !== id);
        registry.servers = registry.servers.filter((s) => s.kinwriters.length > 0);
        save();
        return json({ note, ...view() });
      }
      if (method === "POST" && parts[2] === "restore" && entry.archived) {
        // Back, into a server (this one, or one of their own), exactly as they were.
        const to = (await body(request)).serverId;
        const into = typeof to === "string" ? server(to) : null; // 404 before anything changes
        delete entry.archived;
        // Set aside, they missed changes to the settings and profiles: they catch up, keeping what was theirs.
        const others = inOrder();
        adopt(open(entry), others);
        if (into) into.kinwriters.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", kinwriters: [id] });
        save();
        return json(view());
      }
      const app = kinwriterApp(id);
      if (method === "PUT" && parts[2] === "own" && parts.length === 3) {
        // A section of Settings just for this kinwriter, or shared again (back to everyone's values).
        const input = await body(request);
        const group = input.group as SettingGroup;
        if (!OWN_GROUPS.includes(group) || typeof input.own !== "boolean") {
          throw new HubError(400, `"group" is one of ${OWN_GROUPS.join(", ")}, and "own" is true or false.`);
        }
        setOwnGroup(app.store, group, input.own);
        if (!input.own) await putSettings(app, pick(registry.settings ?? {}, SETTING_GROUPS[group]));
        return json({ own: ownGroups(app.store), settings: pick(app.store.getSettings(), SETTING_GROUPS[group]) });
      }
      if (method === "POST" && parts[2] === "move") {
        // Move a kinwriter to another server, or into a server of their own.
        const to = (await body(request)).serverId;
        // Check where they're going before taking them out of where they are.
        const target = typeof to === "string" ? server(to) : null;
        for (const s of registry.servers) s.kinwriters = s.kinwriters.filter((p) => p !== id);
        if (target) target.kinwriters.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", kinwriters: [id] });
        registry.servers = registry.servers.filter((s) => s.kinwriters.length > 0);
        save();
        return json(view());
      }
    }
    throw new HubError(404, "No such API route.");
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!allowedHost(request.headers.get("host") ?? url.host, config.allowedHosts ?? [])) {
      return json({ error: "Kinaera only answers at localhost or an IP address. To use another name, add it to ALLOWED_HOSTS." }, 421);
    }
    try {
      if (url.pathname === "/api/hub" || url.pathname.startsWith("/api/hub/")) return await hubRoute(request, url.pathname);
      // /p/<id>/...: that kinwriter's app, with the rest of the path.
      const scoped = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
      if (scoped) {
        const id = decodeURIComponent(scoped[1]!);
        const app = kinwriterApp(id);
        url.pathname = scoped[2]!;
        return await forward(id, app, new Request(url.toString(), request));
      }
      return await forward(registry.servers[0]!.kinwriters[0]!, defaultApp(), request);
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.message }, error.status);
      if (error instanceof URIError) return json({ error: "That address isn't written right." }, 400);
      const message = error instanceof Error ? error.message : String(error);
      if (/must be|is too long|non-empty/.test(message)) return json({ error: message }, 400);
      console.error("[hub]", error);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  }

  return {
    fetch,
    apps,
    servers: () => registry.servers,
    start: () => {
      started = true;
      for (const app of apps.values()) startApp(app);
    },
    close: () => {
      groups.stop();
      closeBrowsing();
      for (const app of apps.values()) stopApp(app);
    },
    groups,
  };
}

/**
 * Whether a request's Host is one Kinaera answers to: localhost, a plain IP
 * address, or a name in ALLOWED_HOSTS.
 *
 * This stops "DNS rebinding": a web page on some other site pointing its
 * own name at 127.0.0.1, so your browser treats Kinaera as that site and
 * lets the page read your chats. Such a request still carries the page's
 * own name as its Host, so it's refused here.
 */
export function allowedHost(host: string, extra: string[] = []): boolean {
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (!name) return false;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true; // IPv4
  if (name.includes(":") && /^[0-9a-f:.]+$/.test(name)) return true; // IPv6
  return extra.includes(name);
}
