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
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { listWording, setWording, setWordingOverrides } from "./wording.ts";
import { keepAwake } from "./notify.ts";
import { createApp, type App } from "./server.ts";
import { Groups, type HubGroup } from "./groups.ts";
import { isShared, validateSettings } from "./store.ts";
import { orientationRunning } from "./orientation.ts";
import type { Settings } from "./types.ts";

export interface HubServer {
  id: string;
  /** Its name; "" shows its first kinwriter's name. */
  name: string;
  /** Its kinwriters' ids, in sidebar order. */
  friends: string[];
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
  friends: HubKinwriter[];
  /** Group channels and DMs (src/groups.ts). */
  groups?: HubGroup[];
  /**
   * Kinwriters together (Settings → Advanced, untested): group channels,
   * DMs, and kinwriters knowing about each other. Off (the default), each
   * kinwriter is on their own, even with several on one server.
   */
  together?: boolean;
}

/** Settings that are the kinwriter themselves: never copied to a new kinwriter. */
export const KINWRITER_KEYS: (keyof Settings)[] = [
  "friendName",
  "friendPrompt",
  "literaryPrompt",
  "casualPrompt",
  "oocPrompt",
  "friendAvatar",
  "friendColor",
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

  function load(): Registry {
    if (existsSync(registryPath)) return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
    return { friends: [{ id: "home", dir: "." }], servers: [{ id: crypto.randomUUID(), name: "", friends: ["home"] }] };
  }
  const registry = load();

  function save(): void {
    // Written whole, then renamed over the old one: never half-written.
    const temp = `${registryPath}.tmp`;
    writeFileSync(temp, JSON.stringify(registry, null, 2));
    renameSync(temp, registryPath);
  }
  if (!existsSync(registryPath)) save();

  // Group channels and DMs: shared by several kinwriters, so kept here.
  const groups = new Groups(() => (registry.groups ??= []), apps, save, config.groupDelayMs);

  /** The server a kinwriter is in. */
  const serverOf = (kinwriterId: string) => registry.servers.find((s) => s.friends.includes(kinwriterId));

  function open(kinwriter: HubKinwriter): App {
    const app = makeApp({
      ...config,
      dataDir: resolve(root, kinwriter.dir),
      userThemesDir: join(root, "themes"),
      kinwriterId: kinwriter.id,
      example: kinwriter.id === "home",
      // Who else is on their server (names only), only with kinwriters together.
      peers: () => {
        if (!registry.together) return [];
        const server = registry.servers.find((s) => s.friends.includes(kinwriter.id));
        return (server?.friends ?? [])
          .filter((id) => id !== kinwriter.id && apps.has(id))
          .map((id) => ({ id, name: apps.get(id)!.store.getSettings().friendName }));
      },
      groups: {
        info: (channelId) => groups.info(kinwriter.id, channelId),
        dmWith: (peerId) => {
          const server = serverOf(kinwriter.id);
          if (!server || !server.friends.includes(peerId)) throw new HubError(400, "They aren't on your server.");
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
  for (const kinwriter of registry.friends) if (!kinwriter.archived) open(kinwriter);

  function startApp(app: App): void {
    app.summarizer.scheduleAll(15_000);
    app.heartbeat.start();
    app.rhythms.start();
    if (app.store.getSettings().heartbeatHours > 0) keepAwake();
  }

  function stopApp(app: App): void {
    app.heartbeat.stop();
    app.rhythms.stop();
    app.wakeups.stopReviews();
    app.summarizer.stop();
    app.store.close();
  }

  const defaultApp = () => apps.get(registry.servers[0]!.friends[0]!)!;
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
      name: settings.friendName,
      avatar: settings.friendAvatar,
      color: settings.friendColor,
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
        const copies = g.friends.map((id) => apps.get(id)).filter((a): a is App => a !== undefined && a.store.hasChannel(g.id));
        const last = g.visible || g.kind === "group" ? copies[0]?.store.lastMessage(g.id) : undefined;
        return {
          id: g.id,
          kind: g.kind,
          name: g.kind === "dm" ? g.friends.map((id) => apps.get(id)?.store.getSettings().friendName ?? "?").join(" & ") : g.name,
          friends: g.friends,
          visible: g.kind === "group" || g.visible,
          activity: last ? { lastId: last.id, author: last.author, at: last.createdAt } : null,
          writing: copies.filter((a) => a.kinwriter.isBusy(g.id)).map((a) => a.store.getSettings().friendName),
        };
      });
  }

  function view() {
    return {
      servers: registry.servers.map((s) => ({ ...s, friends: s.friends.map(summary), groups: registry.together ? groupViews(s.id) : [] })),
      together: registry.together === true,
      // Retired kinwriters, with the note they left.
      archived: registry.friends.filter((f) => f.archived).map((f) => ({ id: f.id, ...f.archived! })),
    };
  }

  // ------------------------------------------------------- new kinwriters

  /** Make a kinwriter, copying profiles and preferences from another. */
  function makeKinwriter(input: Record<string, unknown>): string {
    const source = kinwriterApp(typeof input.copyFrom === "string" ? input.copyFrom : registry.servers[0]!.friends[0]!);
    const identity = validateSettings({
      friendName: input.name ?? "New kinwriter",
      ...(input.prompt !== undefined ? { friendPrompt: input.prompt } : {}),
      ...(input.avatar !== undefined ? { friendAvatar: input.avatar } : {}),
      ...(input.color !== undefined ? { friendColor: input.color } : {}),
    });
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const kinwriter: HubKinwriter = { id, dir: join("friends", id) };
    const app = open(kinwriter);
    copyProfiles(source.store.db, app.store.db);
    const preferences = Object.fromEntries(
      Object.entries(source.store.getSettings()).filter(([key]) => !KINWRITER_KEYS.includes(key as keyof Settings)),
    );
    app.store.updateSettings({ ...(preferences as Partial<Settings>), ...identity });
    // Who they were made as is the first version of their identity, which
    // is theirs from now on (src/identity.ts). Their first turn is the
    // orientation their store queued (src/orientation.ts).
    app.store.identity.begin(identity.friendPrompt ?? app.store.getSettings().friendPrompt, typeof input.tastes === "string" ? input.tastes : "");
    if (started) void app.rhythms.tick();
    registry.friends.push(kinwriter);
    return id;
  }

  // ------------------------------------------------------------- routes

  async function body(request: Request): Promise<Record<string, unknown>> {
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
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
    const kinwriter = registry.friends.find((p) => p.id === id);
    if (!kinwriter) throw new HubError(404, "There's no such kinwriter.");
    if (!kinwriter.archived && registry.friends.filter((p) => !p.archived).length === 1) {
      throw new HubError(400, "You need at least one kinwriter, so the last one can't be deleted.");
    }
    if (!kinwriter.archived) {
      stopApp(kinwriterApp(id));
      apps.delete(id);
    }
    removeKinwriterFiles(kinwriter);
    registry.friends = registry.friends.filter((p) => p.id !== id);
    groups.kinwriterGone(id);
    for (const s of registry.servers) s.friends = s.friends.filter((p) => p !== id);
    registry.servers = registry.servers.filter((s) => s.friends.length > 0);
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

    if (parts[0] === "servers") {
      if (method === "POST" && parts.length === 1) {
        // A new server, with a new kinwriter of its own.
        const input = await body(request);
        const kinwriterId = makeKinwriter(input);
        const created: HubServer = { id: crypto.randomUUID(), name: typeof input.serverName === "string" ? input.serverName.trim().slice(0, 100) : "", friends: [kinwriterId] };
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
        if (input.friends !== undefined) {
          // Reorder its kinwriters.
          const ids = input.friends;
          if (!Array.isArray(ids) || ids.length !== target.friends.length || !target.friends.every((p) => ids.includes(p))) {
            throw new HubError(400, "kinwriters must list the server's kinwriters, in the new order.");
          }
          target.friends = ids as string[];
        }
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "friends" && parts.length === 3) {
        // Another kinwriter in this server.
        const kinwriterId = makeKinwriter(await body(request));
        target.friends.push(kinwriterId);
        save();
        return json({ kinwriterId, ...view() });
      }
      if (method === "DELETE" && parts.length === 2) {
        if (registry.servers.length === 1) throw new HubError(400, "You need at least one server, so the last one can't be deleted.");
        if (registry.friends.length === target.friends.length) throw new HubError(400, "That would delete every kinwriter.");
        for (const id of [...target.friends]) deleteKinwriter(id);
        registry.servers = registry.servers.filter((s) => s.id !== target.id);
        save();
        return json(view());
      }
    }

    // Hub-wide options (Settings → Advanced).
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
      if (!registry.together) throw new HubError(400, "Group channels and DMs need Kinwriters together, under Settings → Advanced.");
    }
    if (parts[0] === "servers" && parts[2] === "groups" && method === "POST") {
      const target = server(parts[1] ?? "");
      const input = await body(request);
      const name = typeof input.name === "string" ? input.name.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 100) : "";
      if (!name) throw new HubError(400, "A group channel needs a name.");
      const friends = input.friends;
      if (!Array.isArray(friends) || new Set(friends).size !== friends.length || friends.length < 2 || !friends.every((f) => typeof f === "string" && target.friends.includes(f))) {
        throw new HubError(400, "A group channel needs two or more kinwriters from this server.");
      }
      const group = groups.create("group", target.id, friends as string[], name);
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

    if (parts[0] === "friends" && parts[1]) {
      const id = parts[1];
      const entry = registry.friends.find((f) => f.id === id);
      if (!entry) throw new HubError(404, "There's no such kinwriter.");
      if (method === "DELETE" && parts.length === 2) {
        deleteKinwriter(id);
        save();
        return json(view());
      }
      if (method === "POST" && parts[2] === "archive" && !entry.archived) {
        // Retire them: one last turn for a note, then set aside, whole.
        if (registry.friends.filter((f) => !f.archived).length === 1) throw new HubError(400, "You need at least one kinwriter who isn't archived.");
        const app = kinwriterApp(id);
        const note = await app.farewell();
        const settings = app.store.getSettings();
        entry.archived = { at: new Date().toISOString(), note, name: settings.friendName, avatar: settings.friendAvatar, color: settings.friendColor };
        stopApp(app);
        apps.delete(id);
        for (const s of registry.servers) s.friends = s.friends.filter((p) => p !== id);
        registry.servers = registry.servers.filter((s) => s.friends.length > 0);
        save();
        return json({ note, ...view() });
      }
      if (method === "POST" && parts[2] === "restore" && entry.archived) {
        // Back, into a server (this one, or one of their own), exactly as they were.
        const to = (await body(request)).serverId;
        const into = typeof to === "string" ? server(to) : null; // 404 before anything changes
        delete entry.archived;
        open(entry);
        if (into) into.friends.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", friends: [id] });
        save();
        return json(view());
      }
      kinwriterApp(id);
      if (method === "POST" && parts[2] === "move") {
        // Move a kinwriter to another server, or into a server of their own.
        const to = (await body(request)).serverId;
        for (const s of registry.servers) s.friends = s.friends.filter((p) => p !== id);
        if (typeof to === "string") server(to).friends.push(id);
        else registry.servers.push({ id: crypto.randomUUID(), name: "", friends: [id] });
        registry.servers = registry.servers.filter((s) => s.friends.length > 0);
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
        const app = kinwriterApp(decodeURIComponent(scoped[1]!));
        url.pathname = scoped[2]!;
        return await app.fetch(new Request(url.toString(), request));
      }
      return await defaultApp().fetch(request);
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.message }, error.status);
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
      for (const app of apps.values()) stopApp(app);
    },
    groups,
  };
}

/**
 * Give a new kinwriter the same connection profiles and roulettes as another
 * (same ids, so assignments carry over), replacing the default one.
 */
/** Copy connection profiles and roulettes from one kinwriter's database to another's (same ids, so assignments carry over). */
export function copyProfiles(source: Database, target: Database): void {
  const rows = (table: string) => source.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const copy = (table: string, list: Record<string, unknown>[]) => {
    for (const row of list) {
      const columns = Object.keys(row);
      target
        .query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`)
        .run(Object.fromEntries(columns.map((c) => [c, row[c] as string | number | null])));
    }
  };
  const profiles = rows("profiles");
  const roulettes = rows("roulettes");
  const entries = rows("roulette_profiles");
  target.transaction(() => {
    target.query("DELETE FROM roulette_profiles").run();
    target.query("DELETE FROM roulettes").run();
    target.query("DELETE FROM profiles").run();
    copy("profiles", profiles);
    copy("roulettes", roulettes);
    copy("roulette_profiles", entries);
  })();
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
