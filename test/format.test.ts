/**
 * Tests for the web app's text formatting (public/js/format.js).
 *
 * The web app's modules run in a browser. `format.js` imports `core.js`,
 * which looks up page elements as it loads, so a tiny stand-in `document`
 * is set up first.
 */

import { beforeAll, describe, expect, test } from "bun:test";

/** The browser module, loaded as plain JavaScript (it has no TypeScript types). */
let format: { formatText: (text: string) => string };
const FORMAT_JS = "../public/js/format.js";

beforeAll(async () => {
  (globalThis as any).document ??= { getElementById: () => null, createElement: () => ({}) };
  format = await import(FORMAT_JS);
});

describe("formatText", () => {
  test("escapes HTML before formatting", () => {
    expect(format.formatText('<b onclick="x">hi</b>')).toBe("&lt;b onclick=&quot;x&quot;&gt;hi&lt;/b&gt;");
  });

  test("bold, italics, and actions", () => {
    expect(format.formatText("*leans in* **no**")).toBe("<em>leans in</em> <strong>no</strong>");
    expect(format.formatText("_quietly_")).toBe("<em>quietly</em>");
  });

  test("***bold italics*** nest properly", () => {
    expect(format.formatText("***Finally.***")).toBe("<strong><em>Finally.</em></strong>");
    expect(format.formatText("*walks in* ***stop*** **now**")).toBe("<em>walks in</em> <strong><em>stop</em></strong> <strong>now</strong>");
  });
});

describe("quietSummary", () => {
  const call = (summary: string, status = "ok") => ({ summary, status });
  test("counts actions across turns, ignoring reasons in brackets", async () => {
    const { quietSummary } = (await import(FORMAT_JS)) as any;
    const turns = [
      [call("read the newest messages in #TheCell")],
      [call("chose not to reply (giving them space)")],
      [call("chose not to reply (waiting for them)")],
      [call("chose not to reply")],
    ];
    expect(quietSummary(turns)).toBe("4 quiet turns · chose not to reply 3×, read the newest messages in #TheCell");
  });
  test("notes errors and turns that only thought", async () => {
    const { quietSummary } = (await import(FORMAT_JS)) as any;
    expect(quietSummary([[], [call("x", "error")], []])).toBe("3 quiet turns · 1 error");
  });
  test("keeps the line short when there are many kinds of action", async () => {
    const { quietSummary } = (await import(FORMAT_JS)) as any;
    const turns = ["a", "b", "c", "d", "e"].map((s) => [call(s)]);
    expect(quietSummary(turns)).toBe("5 quiet turns · a, b, c, 2 more");
  });
});
