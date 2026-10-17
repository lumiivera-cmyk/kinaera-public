/**
 * Tests for the notebook's permission rules (src/permissions.ts): the table
 * in DESIGN.md's "Notebook and permissions", one rule at a time.
 */

import { describe, expect, test } from "bun:test";
import {
  canChangeSettings,
  canHavePrefix,
  canDelete,
  canSee,
  editAccess,
  effectiveSettings,
  playedBy,
  plays,
} from "../src/permissions.ts";
import type { EffectiveSettings, NotebookEntry, NotebookFolder } from "../src/types.ts";

function entry(overrides: Partial<NotebookEntry>): NotebookEntry {
  return {
    id: "e",
    kind: "character",
    name: "Ilse",
    fields: [],
    systemPrompt: "",
    proxyPrefix: null,
    folderId: null,
    owner: "kinwriter",
    visibility: null,
    editing: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function folder(overrides: Partial<NotebookFolder>): NotebookFolder {
  return { id: "f", name: "Secrets", owner: "kinwriter", visibility: "hidden", editing: "locked", position: 0, practice: false, createdAt: "", ...overrides };
}

const settings = (owner: EffectiveSettings["owner"], visibility = "visible", editing = "open") =>
  ({ owner, visibility, editing }) as EffectiveSettings;

describe("effectiveSettings", () => {
  test("with nothing set, an entry is visible and open", () => {
    expect(effectiveSettings(entry({}), null)).toEqual(settings("kinwriter"));
  });

  test("an entry with no settings of its own takes its folder's", () => {
    expect(effectiveSettings(entry({ folderId: "f" }), folder({}))).toEqual(settings("kinwriter", "hidden", "locked"));
  });

  test("an entry's own settings win over its folder's", () => {
    const own = entry({ folderId: "f", visibility: "visible", editing: "suggest" });
    expect(effectiveSettings(own, folder({}))).toEqual(settings("kinwriter", "visible", "suggest"));
  });

  test("shared lore is always visible and suggest-only, whatever is stored", () => {
    const lore = entry({ owner: "joint", visibility: "hidden", editing: "open", folderId: "f" });
    expect(effectiveSettings(lore, folder({}))).toEqual(settings("joint", "visible", "suggest"));
  });
});

describe("canSee", () => {
  test("the owner always sees their own entries", () => {
    expect(canSee("kinwriter", settings("kinwriter", "hidden"))).toBe(true);
    expect(canSee("user", settings("user", "hidden"))).toBe(true);
  });

  test("the other person sees only what isn't hidden", () => {
    expect(canSee("user", settings("kinwriter", "visible"))).toBe(true);
    expect(canSee("user", settings("kinwriter", "hidden"))).toBe(false);
    expect(canSee("kinwriter", settings("user", "hidden"))).toBe(false);
  });
});

describe("editAccess", () => {
  test("the owner edits directly, whatever the editing setting", () => {
    expect(editAccess("user", settings("user", "visible", "locked"))).toBe("direct");
  });

  test("the other person follows the editing setting", () => {
    expect(editAccess("user", settings("kinwriter", "visible", "open"))).toBe("direct");
    expect(editAccess("user", settings("kinwriter", "visible", "suggest"))).toBe("suggest");
    expect(editAccess("user", settings("kinwriter", "visible", "locked"))).toBe("none");
  });

  test("nobody edits what they can't see", () => {
    expect(editAccess("user", settings("kinwriter", "hidden", "open"))).toBe("none");
  });

  test("shared lore is suggest-only for both of you", () => {
    expect(editAccess("user", settings("joint"))).toBe("suggest");
    expect(editAccess("kinwriter", settings("joint"))).toBe("suggest");
  });
});

describe("canChangeSettings and canDelete", () => {
  test("only the owner changes settings, and shared lore's are fixed", () => {
    expect(canChangeSettings("user", "user")).toBe(true);
    expect(canChangeSettings("user", "kinwriter")).toBe(false);
    expect(canChangeSettings("user", "joint")).toBe(false);
  });

  test("each of you deletes only your own entries", () => {
    expect(canDelete("user", settings("user"))).toBe(true);
    expect(canDelete("user", settings("kinwriter"))).toBe(false);
    expect(canDelete("user", settings("joint"))).toBe(false);
    expect(canDelete("kinwriter", settings("kinwriter"))).toBe(true);
    expect(canDelete("kinwriter", settings("user"))).toBe(false);
  });
});

describe("who plays a character", () => {
  test("yours are yours, your kinwriter's are theirs, and shared ones are both of yours", () => {
    expect(playedBy({ owner: "user" })).toBe("user");
    expect(playedBy({ owner: "kinwriter" })).toBe("kinwriter");
    expect(playedBy({ owner: "joint" })).toBe("both");
    expect(plays("user", { owner: "joint" })).toBe(true);
    expect(plays("kinwriter", { owner: "joint" })).toBe(true);
    expect(plays("user", { owner: "kinwriter" })).toBe(false);
  });

  test("only characters you play can have a proxy prefix", () => {
    expect(canHavePrefix({ kind: "character", owner: "user" })).toBe(true);
    expect(canHavePrefix({ kind: "character", owner: "joint" })).toBe(true);
    expect(canHavePrefix({ kind: "character", owner: "kinwriter" })).toBe(false);
    expect(canHavePrefix({ kind: "lore", owner: "user" })).toBe(false);
  });
});
