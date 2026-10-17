/**
 * Tests for identity suggestions (src/identity.ts): accepting one takes
 * only what it changed, so a revision made in between isn't undone.
 */

import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Identity } from "../src/identity.ts";

function identity() {
  let t = Date.parse("2026-01-01T00:00:00Z");
  const mirrored: string[] = [];
  // Each call a second later, so versions are in a clear order.
  const id = new Identity(openDatabase(":memory:"), (text) => mirrored.push(text), () => new Date((t += 1000)));
  id.begin("I'm Arlo.", "Loves storms.");
  return { id, mirrored };
}

test("accepting a suggestion keeps a revision made since it", () => {
  const { id, mirrored } = identity();
  const suggestion = id.suggest({ tastes: "Loves storms and opera." });
  id.revise({ identity: "I'm Arlo, and I write lighthouses." });
  const accepted = id.review(suggestion.id, "accept", "Yes!");
  expect(accepted).toMatchObject({ identity: "I'm Arlo, and I write lighthouses.", tastes: "Loves storms and opera.", reply: "Yes!" });
  expect(id.current()!.id).toBe(accepted.id);
  expect(mirrored.at(-1)).toBe("I'm Arlo, and I write lighthouses.");
});

test("a suggestion accepted in between counts as what came before a later one", () => {
  const { id } = identity();
  const first = id.suggest({ identity: "I'm Arlo, a sailor." });
  const second = id.suggest({ tastes: "Loves rain." });
  id.review(first.id, "accept");
  expect(id.review(second.id, "accept")).toMatchObject({ identity: "I'm Arlo, a sailor.", tastes: "Loves rain." });
});

test("declining leaves the identity as it is", () => {
  const { id } = identity();
  const suggestion = id.suggest({ tastes: "Loves opera." });
  expect(id.review(suggestion.id, "decline", "Not me.")).toMatchObject({ status: "declined", reply: "Not me." });
  expect(id.current()!.tastes).toBe("Loves storms.");
});
