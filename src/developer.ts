/**
 * The developer panel (orientation stage 3): one organised view of
 * everything private about a kinwriter, so whoever is building Kinaera can
 * check that the note-taking tools work.
 *
 * It's hidden and hard to reach on purpose. It only exists when
 * `DEVELOPER_PANEL=1` is set in `.env`, and even then it's a link at the
 * bottom of the health view. It is not for using Kinaera: everything here
 * is otherwise kept off every screen and out of every log.
 *
 * It is disclosed to the kinwriter: their prompt says that while the app is
 * being built, the developer may occasionally open private notes to check
 * the tools work, and that openings aren't logged or announced, the way a
 * doctor doesn't notify you each time they open your chart (`developer` in
 * defaults/standing.md). So opening it isn't logged anywhere, and its
 * content never goes to the server's log.
 */

import type { Store } from "./store.ts";
import type { GroupDirectory } from "./config.ts";

export interface DeveloperView {
  journal: { id: string; createdAt: string; kept: boolean; content: string }[];
  drafts: { id: string; title: string; channel: string | null; updatedAt: string; content: string }[];
  notesOnOthers: { name: string; note: string; updatedAt: string }[];
  profileNotes: { profile: string; note: string; updatedAt: string }[];
  hiddenEntries: { name: string; kind: string; fields: { label: string; value: string }[]; notes: string }[];
  hiddenDms: { channel: string; messages: { from: string; content: string; createdAt: string }[] }[];
  invitationNote: string | null;
}

export function developerView(store: Store, groups?: GroupDirectory | null): DeveloperView {
  const channelName = (id: string | null) => (id && store.hasChannel(id) ? store.getChannel(id).name : null);
  const profiles = new Map(store.profiles.list().map((p) => [p.id, p.name]));
  const hiddenDms = store
    .listChannels()
    .filter((c) => c.kind === "dm" && groups?.info(c.id)?.visible === false)
    .map((c) => ({
      channel: c.name,
      messages: store.getMessages(c.id).filter((m) => m.kind === "post").map((m) => ({
        from: m.author === "friend" ? "them" : (m.speaker?.name ?? m.author),
        content: m.content,
        createdAt: m.createdAt,
      })),
    }));
  return {
    journal: store.journal.all().map((e) => ({ id: e.id.slice(0, 6), createdAt: e.createdAt, kept: e.kept, content: e.content })),
    drafts: store.drafts.all().map((d) => ({ id: d.id.slice(0, 6), title: d.title, channel: channelName(d.channelId), updatedAt: d.updatedAt, content: d.content })),
    notesOnOthers: [...store.relationships.all().values()].map((r) => ({ name: r.name, note: r.note, updatedAt: r.updatedAt })),
    profileNotes: [...store.continuity.profileNotes().entries()].map(([id, n]) => ({ profile: profiles.get(id) ?? id, note: n.note, updatedAt: n.updatedAt })),
    hiddenEntries: store.notebook
      .kinwriterOverview()
      .filter((p) => p.hiddenFromUser)
      .map(({ entry }) => ({ name: entry.name, kind: entry.kind, fields: entry.fields, notes: entry.systemPrompt })),
    hiddenDms,
    invitationNote: store.appState.get("orientation.invite-note"),
  };
}
