/**
 * Tests for the nanoGPT client (src/nanogpt.ts): reading replies of odd
 * shapes, and `<think>` reasoning however it arrives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, createChatCompletion, readReasoning, requestBody, stripReasoning } from "../src/nanogpt.ts";

describe("<think> reasoning", () => {
  test("whole pairs are removed, and kept as reasoning", () => {
    const text = "<think>They want drama.</think>\n\nThe storm breaks.";
    expect(stripReasoning(text)).toBe("The storm breaks.");
    expect(readReasoning(undefined, text)).toBe("They want drama.");
  });

  test("cut off at Max tokens: an opening tag never closed thinks to the end", () => {
    const text = "<think>Let me consider the lighthouse, and";
    expect(stripReasoning(text)).toBe("");
    expect(readReasoning(undefined, text)).toBe("Let me consider the lighthouse, and");
  });

  test("only a closing tag: everything before it was thinking", () => {
    const text = "They want drama.</think>\n\nThe storm breaks.";
    expect(stripReasoning(text)).toBe("The storm breaks.");
    expect(readReasoning(undefined, text)).toBe("They want drama.");
  });

  test("a reply with no tags is left alone", () => {
    expect(stripReasoning("  Just a reply. ")).toBe("Just a reply.");
    expect(readReasoning(undefined, "Just a reply.")).toBe("");
  });
});

describe("requestBody", () => {
  test("tool_choice none is sent with the tools", () => {
    const tool = { type: "function" as const, function: { name: "x", description: "", parameters: {} } };
    const body = requestBody({ model: "m", messages: [], temperature: 1, maxTokens: 10, tools: [tool], toolChoice: "none" });
    expect(body.tool_choice).toBe("none");
    expect(body.tools).toEqual([tool]);
  });
});

describe("odd replies", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => server?.stop(true));

  /** A server that answers every request with this body, HTTP 200. */
  function replyWith(body: string) {
    server = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { "Content-Type": "application/json" } }) });
    return { apiKey: "k", baseUrl: `http://127.0.0.1:${server.port}`, timeoutMs: 5000 };
  }
  const request = { model: "m", messages: [], temperature: 1, maxTokens: 10, allowEmpty: true };

  test("a body of null is an ApiError, even when an empty reply is allowed", async () => {
    const api = replyWith("null");
    await expect(createChatCompletion(api, request)).rejects.toBeInstanceOf(ApiError);
  });

  test("an error sent with HTTP 200 is an error, not an empty reply", async () => {
    const api = replyWith(JSON.stringify({ error: { message: "upstream overloaded" } }));
    await expect(createChatCompletion(api, request)).rejects.toThrow("upstream overloaded");
  });
});
