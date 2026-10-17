/**
 * A small client for nanoGPT's API.
 *
 * nanoGPT gives one API key access to many models (DeepSeek, GLM, Kimi, ...)
 * and speaks the same "chat completions" format as OpenAI. A request is a
 * plain HTTPS POST with a JSON body:
 *
 *   POST https://nano-gpt.com/api/v1/chat/completions
 *   Authorization: Bearer <your key>
 *   { "model": "...", "messages": [...], "temperature": 0.9, "max_tokens": 1024 }
 *
 * and the reply is JSON with the generated text at
 * `choices[0].message.content`.
 *
 * This file uses the built-in `fetch`, so there is no SDK to install.
 */

import type { ApiMessage, ReasoningEffort } from "./types.ts";

/** What the client needs to know to reach the API. */
export interface ApiOptions {
  apiKey: string;
  /** e.g. `https://nano-gpt.com/api/v1` (no trailing slash). */
  baseUrl: string;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
}

/** A tool the model may call, in the API's format (see `src/tools.ts`). */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** A tool call the model asked for, as returned by the API. */
export interface NativeToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON text, which may be broken. */
  arguments: string;
}

/** The parameters of one generation request. */
export interface CompletionRequest {
  model: string;
  messages: ApiMessage[];
  temperature: number;
  maxTokens: number;
  /** Nucleus sampling. Left out of the request when not set. */
  topP?: number | null;
  /** Min P sampling. Left out of the request when not set. */
  minP?: number | null;
  /** How hard a reasoning model thinks. Left out when not set. */
  reasoningEffort?: ReasoningEffort | null;
  /** More request fields, sent as they are (a profile's extra parameters). */
  extraParams?: Record<string, unknown>;
  /** Tools the model may call. Left out when empty. */
  tools?: ToolSpec[];
  /**
   * "required": the model must call a tool this round (after a reflex
   * reminder: act, or choose not to). "none": the tools are sent, but it
   * can't call them (a turn's last round). Default "auto". Some providers
   * ignore it, so the caller still handles a reply with or without calls.
   */
  toolChoice?: "auto" | "required" | "none";
  /**
   * Accept a reply with no text and no tool calls instead of treating it as
   * an error. Used after tool calls, when the model may have nothing more
   * to say.
   */
  allowEmpty?: boolean;
  /**
   * Lets the caller stop the request early (the Stop button). When this
   * signal fires, the request is abandoned and `CancelledError` is thrown.
   */
  signal?: AbortSignal;
}

/** A successful generation. */
export interface CompletionResult {
  /** The generated text, with any `<think>` reasoning removed. May be "" if the model only called tools. */
  content: string;
  /** Tool calls the model asked for through the API (not ones written as text). */
  toolCalls: NativeToolCall[];
  /** The model that actually answered, as reported by the API. */
  model: string;
  /** Why generation stopped: `"stop"` is normal, `"length"` means it hit `maxTokens`. */
  finishReason: string | null;
  /**
   * The model's reasoning before it answered, for a thinking model: from the
   * API's reasoning field, or the `<think>` text removed from `content`.
   * "" when there was none (most models, or a provider that hides it).
   */
  reasoning: string;
}

/**
 * An error from the API, carrying the HTTP status when there is one.
 * The message is written to be shown to you directly in the app.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Thrown when a request was stopped on purpose, through its `signal`. */
export class CancelledError extends Error {
  constructor() {
    super("The reply was stopped.");
    this.name = "CancelledError";
  }
}

/**
 * Ask the model for one reply.
 *
 * Throws `CancelledError` if `request.signal` fires, and `ApiError` if the
 * key is missing, the network fails, the request times out, the API returns
 * an error, or the reply is empty.
 */
export async function createChatCompletion(
  options: ApiOptions,
  request: CompletionRequest,
): Promise<CompletionResult> {
  if (!options.apiKey) {
    throw new ApiError("No nanoGPT API key is set. Add NANOGPT_API_KEY to your .env file and restart the server.");
  }

  // The request body. Note the API uses snake_case (`max_tokens`), while
  // our own code uses camelCase (`maxTokens`).
  const body = requestBody(request);
  const json = await postJson(options, "/chat/completions", body, request.signal);

  // Dig the text out of the response. Everything is checked because a model
  // provider having a bad day can return all sorts of shapes.
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ApiError("nanoGPT sent back a reply with nothing in it.");
  }
  // Some providers send an error with HTTP 200: never mistake it for an empty reply.
  const error = (json as { error?: { message?: unknown } | string }).error;
  if (error && !(json as { choices?: unknown }).choices) {
    const detail = typeof error === "string" ? error : typeof error.message === "string" ? error.message : "";
    throw new ApiError(`nanoGPT returned an error${detail ? ` (${detail})` : "."}`);
  }
  const choice = (json as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: unknown; tool_calls?: unknown } & ReasoningFields; finish_reason?: string }
    | undefined;
  const rawContent = choice?.message?.content;
  const toolCalls = readToolCalls(choice?.message?.tool_calls);
  // With tool calls, content is often `null`: the model only acted.
  if (typeof rawContent !== "string" && toolCalls.length === 0 && !request.allowEmpty) {
    throw new ApiError("The model's reply didn't contain any text.");
  }

  const content = typeof rawContent === "string" ? stripReasoning(rawContent) : "";
  if (content === "" && toolCalls.length === 0 && !request.allowEmpty) {
    throw new ApiError(
      choice?.finish_reason === "length"
        ? "The model ran out of tokens before writing anything. Try raising Max tokens."
        : "The model returned an empty reply.",
    );
  }

  return {
    content,
    toolCalls,
    model: typeof (json as { model?: unknown }).model === "string" ? (json as { model: string }).model : request.model,
    finishReason: choice?.finish_reason ?? null,
    reasoning: readReasoning(choice?.message, typeof rawContent === "string" ? rawContent : ""),
  };
}

/** Where providers put a thinking model's reasoning in a reply's message. */
interface ReasoningFields {
  reasoning?: unknown;
  reasoning_content?: unknown;
  reasoning_details?: unknown;
}

/**
 * A thinking model's reasoning, wherever the reply carries it. nanoGPT
 * sends it as `message.reasoning` (`reasoning_content` on its legacy
 * endpoint), some providers only as `reasoning_details` pieces, and some
 * models write it into the text inside `<think>` tags.
 */
export function readReasoning(message: ReasoningFields | undefined, rawContent: string): string {
  const field = [message?.reasoning, message?.reasoning_content].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof field === "string") return field.trim();
  if (Array.isArray(message?.reasoning_details)) {
    const pieces = message.reasoning_details
      .map((d) => (d as { text?: unknown; summary?: unknown })?.text ?? (d as { summary?: unknown })?.summary)
      .filter((t): t is string => typeof t === "string" && t.trim() !== "");
    if (pieces.length) return pieces.join("\n\n").trim();
  }
  return thinkParts(rawContent).reasoning.join("\n\n");
}

/**
 * A reply's text split into its `<think>` reasoning and the rest. Besides
 * whole `<think>...</think>` pairs: a reply with only the closing tag (the
 * provider ate the opening one) thinks up to it, and an opening tag never
 * closed (cut off at Max tokens) thinks to the end.
 */
function thinkParts(text: string): { reasoning: string[]; rest: string } {
  const reasoning: string[] = [];
  let rest = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inside: string) => {
    reasoning.push(inside);
    return "";
  });
  const end = rest.toLowerCase().lastIndexOf("</think>");
  if (end >= 0) {
    reasoning.unshift(rest.slice(0, end).replace(/<\/think>/gi, ""));
    rest = rest.slice(end + "</think>".length);
  }
  const open = rest.search(/<think>/i);
  if (open >= 0) {
    reasoning.push(rest.slice(open + "<think>".length));
    rest = rest.slice(0, open);
  }
  return { reasoning: reasoning.map((r) => r.trim()).filter(Boolean), rest: rest.trim() };
}

/**
 * The JSON body for a request. Optional settings are only sent when they're
 * set, because some models reject parameters they don't know.
 */
export function requestBody(request: CompletionRequest): Record<string, unknown> {
  return {
    // A profile's extra fields go first, so the app's own fields win.
    ...request.extraParams,
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    ...(request.topP != null ? { top_p: request.topP } : {}),
    ...(request.minP != null ? { min_p: request.minP } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" } : {}),
    // The whole reply at once, not streamed word by word.
    stream: false,
  };
}

/**
 * Read `message.tool_calls` from a response, tolerating the variations
 * between providers: arguments sent as an object instead of JSON text, or a
 * missing id.
 */
function readToolCalls(value: unknown): NativeToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = call?.function?.name;
    if (typeof name !== "string" || name === "") return [];
    const args = call.function?.arguments;
    return [
      {
        id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      },
    ];
  });
}

/**
 * What nanoGPT says a model can do (its `capabilities` and limits, from
 * `GET /models?detailed=true`). A field is left out when the API didn't
 * say, so "unknown" never reads as "can't". The API says nothing about
 * sampling settings (temperature, Top P, Min P), so those aren't here.
 */
export interface ModelInfo {
  id: string;
  /** It can think before answering, so the reasoning setting applies. */
  reasoning?: boolean;
  /** It can call tools. */
  toolCalling?: boolean;
  /** The most tokens it can write in one reply. */
  maxOutputTokens?: number;
}

/**
 * List the models available to your key, for the settings panel, with what
 * each one supports. Sorted alphabetically by id.
 */
export async function listModels(options: ApiOptions): Promise<ModelInfo[]> {
  const json = await request(options, "/models?detailed=true", { method: "GET" });
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .flatMap((raw) => {
      const entry = raw as { id?: unknown; capabilities?: Record<string, unknown>; max_output_tokens?: unknown };
      if (typeof entry?.id !== "string") return [];
      const info: ModelInfo = { id: entry.id };
      const caps = entry.capabilities;
      if (typeof caps?.reasoning === "boolean") info.reasoning = caps.reasoning;
      if (typeof caps?.tool_calling === "boolean") info.toolCalling = caps.tool_calling;
      const max = entry.max_output_tokens;
      if (typeof max === "number" && Number.isFinite(max) && max > 0) info.maxOutputTokens = max;
      return [info];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Remove "thinking" text from a reply.
 *
 * Some reasoning models put their private reasoning inside
 * `<think>...</think>` tags at the start of the reply. That's not part of the
 * post, so it's removed (a lone closing tag, or an opening tag never closed,
 * too: see `thinkParts`). (It's kept apart as the reply's `reasoning`; see
 * `readReasoning`.)
 */
export function stripReasoning(text: string): string {
  return thinkParts(text).rest;
}

// ------------------------------------------------------------------ helpers

function postJson(options: ApiOptions, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return request(
    options,
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
}

/**
 * Send one request and return the parsed JSON response, turning every kind
 * of failure into an `ApiError` (or `CancelledError`) with a readable message.
 *
 * @param signal  Optional: stops the request early when it fires.
 */
async function request(options: ApiOptions, path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  // Stop the request when *either* the timeout runs out or the caller's
  // signal fires, whichever comes first.
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;

  let response: Response;
  let text: string;
  // Both steps are inside the try: the model can stall before the reply
  // starts *or* halfway through sending it, and either must be caught.
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${options.apiKey}` },
      signal: stop,
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new CancelledError();
    if (timeout.aborted) {
      throw new ApiError(`The model took longer than ${Math.round(options.timeoutMs / 1000)} seconds to reply.`);
    }
    throw new ApiError(`Couldn't reach nanoGPT: ${(error as Error).message}`);
  }

  if (!response.ok) {
    throw new ApiError(describeHttpError(response.status, text), response.status);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("nanoGPT sent back something that isn't JSON.", response.status);
  }
}

/** A friendly explanation for an HTTP error status, plus the API's own message if it sent one. */
function describeHttpError(status: number, body: string): string {
  const hints: Record<number, string> = {
    401: "nanoGPT rejected the API key. Check NANOGPT_API_KEY in your .env file.",
    402: "nanoGPT says your balance is too low.",
    404: "nanoGPT doesn't recognise that model id. Check the model in settings.",
    429: "nanoGPT is rate-limiting you. Wait a moment and try again.",
  };
  const hint = hints[status] ?? `nanoGPT returned an error (HTTP ${status}).`;

  // Error bodies are usually `{ "error": { "message": "..." } }`.
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    const err = parsed.error;
    detail = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
  } catch {
    detail = body.slice(0, 200);
  }
  return detail ? `${hint} (${detail})` : hint;
}
