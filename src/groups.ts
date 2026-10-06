/**
 * Group channels and DMs: channels with
 * several kinwriters in them. They live in the hub (src/hub.ts), because no
 * kinwriter's store may hold another's memory.
 *
 * **Each kinwriter keeps their own copy.** A group channel is a channel in
 * every member's own database, under the same id, and every message in it
 * is mirrored to every copy under the same id. In a kinwriter's copy their own
 * messages are theirs ("kinwriter"), yours are yours, and the other kinwriters'
 * are by a "peer", with the kinwriter's id and name. So each kinwriter remembers
 * the group from where they stood, and nothing else crosses over: not
 * their notebook, journal, or any other channel.
 *
 * Every add, edit and delete in one copy (`Store.onMessageEvent`) is
 * mirrored to the others. An edit or deletion of a kinwriter's message is
 * recorded properly in that kinwriter's own copy (with its revision, and in
 * their intervention log, if you made it); the others just follow.
 *
 * **Rounds (floor control).** A round starts only when you post in a group
 * channel. Each kinwriter in it may take one turn, in random order, and each
 * sees what the others already wrote. Doing nothing is the default.
 * Kinwriters' messages never start a round.
 *
 * **@mentions** are the one way a kinwriter's message pulls someone else in:
 * "@Name" guarantees that kinwriter one turn, even outside a round. A turn
 * given by an @mention can't grant another (its @mentions just display), so
 * one message of yours leads to at most a round plus one layer of replies.
 *
 * **DMs** are between two kinwriters. You can't write in them, and whether you
 * can see them is up to you, per pair (visible by default); both kinwriters
 * are told which. A kinwriter writes in one with `message_kinwriter`, and the
 * other sees it waiting on their next turn, and answers on a free moment
 * of theirs, under the same hard rules as any turn of their own.
 */

import type { GroupInfo, Peer } from "./config.ts";
import type { App } from "./server.ts";
import type { Message } from "./types.ts";

/** A group channel or DM, as the hub keeps it (hub.json). */
export interface HubGroup {
  /** The channel's id, the same in every member's store. */
  id: string;
  kind: "group" | "dm";
  name: string;
  /** The server it's in. */
  serverId: string;
  /** Its kinwriters' ids. */
  friends: string[];
  /** DMs: whether you can see it. */
  visible: boolean;
  createdAt: string;
}

/** How long after your last message in a group a round starts (so several quick messages make one round). */
export const ROUND_DELAY_MS = 1500;

/** "@Name" mentions of the given kinwriters in some text (whole names, any case). */
export function mentionsIn(text: string, friends: Peer[]): string[] {
  const found: string[] = [];
  for (const kinwriter of friends) {
    const escaped = kinwriter.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, "i").test(text)) found.push(kinwriter.id);
  }
  return found;
}

export class Groups {
  /** Rounds waiting to start, and groups with a round running. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  /** For tests: resolves when the rounds and mention turns started so far are done. */
  private pending: Promise<unknown>[] = [];

  constructor(
    private readonly list: () => HubGroup[],
    private readonly apps: Map<string, App>,
    private readonly save: () => void,
    private readonly delayMs = ROUND_DELAY_MS,
    private readonly random: () => number = Math.random,
  ) {}

  get(id: string): HubGroup | undefined {
    return this.list().find((g) => g.id === id);
  }

  private nameOf(kinwriterId: string): string {
    return this.apps.get(kinwriterId)?.store.getSettings().friendName ?? "a kinwriter";
  }

  /** What a kinwriter in a group knows of it: the other members, and whether you can see it. */
  info(kinwriterId: string, channelId: string): GroupInfo | null {
    const group = this.get(channelId);
    if (!group || !group.friends.includes(kinwriterId)) return null;
    return {
      kind: group.kind,
      members: group.friends.filter((id) => id !== kinwriterId).map((id) => ({ id, name: this.nameOf(id) })),
      visible: group.kind === "group" || group.visible,
    };
  }

  // ------------------------------------------------------------ making

  /**
   * Make a group channel (you and several kinwriters) or a DM (two kinwriters):
   * a channel with the same id in each member's store.
   */
  create(kind: "group" | "dm", serverId: string, friends: string[], name: string): HubGroup {
    const group: HubGroup = { id: crypto.randomUUID(), kind, name, serverId, friends, visible: true, createdAt: new Date().toISOString() };
    for (const kinwriterId of friends) this.addCopy(group, kinwriterId);
    this.list().push(group);
    this.save();
    return group;
  }

  /** A member's copy of the channel. A DM is named after the other kinwriter, in each copy. */
  private addCopy(group: HubGroup, kinwriterId: string): void {
    const store = this.apps.get(kinwriterId)?.store;
    if (!store || store.hasChannel(group.id)) return;
    const other = group.friends.find((id) => id !== kinwriterId);
    const name = group.kind === "dm" ? `dm-${this.nameOf(other ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : group.name;
    store.createChannel({ id: group.id, name, kind: group.kind });
  }

  /** The DM between two kinwriters, made if there isn't one yet. */
  dm(serverId: string, a: string, b: string): HubGroup {
    const existing = this.list().find((g) => g.kind === "dm" && g.friends.includes(a) && g.friends.includes(b));
    return existing ?? this.create("dm", serverId, [a, b], "dm");
  }

  rename(id: string, name: string): void {
    const group = this.get(id);
    if (!group || group.kind !== "group") return;
    group.name = name;
    for (const kinwriterId of group.friends) this.apps.get(kinwriterId)?.store.updateChannel(id, { name });
    this.save();
  }

  /** Delete a group channel or DM from every member's store. */
  remove(id: string): void {
    const group = this.get(id);
    if (!group) return;
    for (const kinwriterId of group.friends) {
      const store = this.apps.get(kinwriterId)?.store;
      if (store?.hasChannel(id)) store.deleteChannel(id);
    }
    const all = this.list();
    all.splice(all.indexOf(group), 1);
    this.save();
  }

  /** A kinwriter was deleted: they leave their groups (their copies go with them). */
  kinwriterGone(kinwriterId: string): void {
    for (const group of this.list()) group.friends = group.friends.filter((id) => id !== kinwriterId);
    this.save();
  }

  // --------------------------------------------------------- mirroring

  /**
   * Something changed in one member's copy (`Store.onMessageEvent`): mirror
   * it to the others, and start a round if it was you writing.
   */
  onEvent(kinwriterId: string, event: "added" | "edited" | "deleted", message: Message): void {
    const group = this.get(message.channelId);
    if (!group || !group.friends.includes(kinwriterId)) return;
    // Whose message it is: yours, or which kinwriter's.
    const owner = message.author === "user" ? null : message.author === "friend" ? kinwriterId : (message.speaker?.id ?? null);
    for (const otherId of group.friends) {
      if (otherId === kinwriterId) continue;
      const store = this.apps.get(otherId)?.store;
      if (!store || !store.hasChannel(group.id)) continue;
      if (event === "added") {
        store.mirrorAdd({
          id: message.id,
          channelId: group.id,
          kind: message.kind,
          mode: message.mode,
          turnId: message.turnId,
          content: message.content,
          createdAt: message.createdAt,
          characters: message.characters,
          replyTo: message.replyTo ?? null,
          ...(owner === null
            ? { author: "user" as const }
            : owner === otherId
              ? { author: "friend" as const }
              : { author: "peer" as const, speaker: { id: owner, name: this.nameOf(owner) } }),
        });
      } else if (event === "edited") {
        // You editing a kinwriter's message: in their own copy, it's a real edit (with its history).
        if (owner === otherId && message.editedBy === "user") this.safely(() => store.editMessage(message.id, message.content, "user"));
        else store.mirrorEdit(message.id, message.content);
      } else {
        if (owner === otherId && message.deletedBy === "user") this.safely(() => store.deleteMessage(message.id, "user"));
        else store.mirrorDelete(message.id);
      }
    }

    if (event !== "added" || message.kind !== "post") return;
    if (message.author === "user" && group.kind === "group") {
      this.scheduleRound(group.id);
    } else if (message.author === "friend" && !this.inRound.has(`${group.id}:${kinwriterId}`)) {
      // A kinwriter writing outside a round: their @mentions give one turn each.
      const mentioned = mentionsIn(message.content, group.friends.filter((id) => id !== kinwriterId).map((id) => ({ id, name: this.nameOf(id) })));
      for (const id of mentioned) this.track(this.turn(group.id, id));
    }
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      // Already done in that copy.
    }
  }

  // ------------------------------------------------------------ rounds

  /** Who's taking a round turn right now (`group:kinwriter`): their @mentions are handled by the round. */
  private readonly inRound = new Set<string>();

  private scheduleRound(groupId: string): void {
    clearTimeout(this.timers.get(groupId));
    const start = () => {
      this.timers.delete(groupId);
      // One round at a time per group: a new one waits for the last.
      const previous = this.running.get(groupId) ?? Promise.resolve();
      const round = previous.then(() => this.round(groupId));
      this.running.set(groupId, round);
      this.track(round);
    };
    if (this.delayMs <= 0) start();
    else this.timers.set(groupId, setTimeout(start, this.delayMs));
  }

  /**
   * One round: each kinwriter in the group may take one turn, in random order,
   * each seeing what the others wrote. Their @mentions give the mentioned
   * kinwriters one more turn each, which can't give any more.
   */
  private async round(groupId: string): Promise<void> {
    const group = this.get(groupId);
    if (!group) return;
    const queue = this.shuffle([...group.friends]).map((id) => ({ id, grants: true }));
    const mentionTurns = new Set<string>();
    while (queue.length > 0) {
      const { id, grants } = queue.shift()!;
      const key = `${groupId}:${id}`;
      this.inRound.add(key);
      let written: Message[] = [];
      try {
        written = await this.takeTurn(groupId, id);
      } finally {
        this.inRound.delete(key);
      }
      if (!grants) continue;
      const others = group.friends.filter((f) => f !== id).map((f) => ({ id: f, name: this.nameOf(f) }));
      for (const mentioned of mentionsIn(written.map((m) => m.content).join("\n"), others)) {
        if (mentionTurns.has(mentioned)) continue;
        mentionTurns.add(mentioned);
        queue.push({ id: mentioned, grants: false });
      }
    }
  }

  /** A single turn given by an @mention, outside a round (it can't give any more). */
  private async turn(groupId: string, kinwriterId: string): Promise<void> {
    const key = `${groupId}:${kinwriterId}`;
    this.inRound.add(key);
    try {
      await this.takeTurn(groupId, kinwriterId);
    } finally {
      this.inRound.delete(key);
    }
  }

  /** One kinwriter's turn in a group; what they wrote. Never throws. */
  private async takeTurn(groupId: string, kinwriterId: string): Promise<Message[]> {
    const app = this.apps.get(kinwriterId);
    if (!app || !app.store.hasChannel(groupId) || app.kinwriter.isBusy(groupId)) return [];
    try {
      const result = await app.kinwriter.takeTurn(groupId, "group", { group: true });
      return result.messages;
    } catch (error) {
      console.warn(`[groups] ${this.nameOf(kinwriterId)}'s turn in a group failed: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }

  private shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }

  private track(work: Promise<unknown>): void {
    this.pending.push(work);
  }

  /** Wait for every round and turn started so far (tests). */
  async settle(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.allSettled(batch);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
