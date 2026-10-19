/**
 * Tests for Settings → API key and setup: editing `.env` in the app
 * (src/envfile.ts, the hub's /api/hub/env).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHub, type Hub } from "../src/hub.ts";
import { parseEnv, updateEnv } from "../src/envfile.ts";
import { startFakeNanoGpt, tempDir, testConfig, type FakeNanoGpt } from "./helpers.ts";

let fake: FakeNanoGpt;
let dir: ReturnType<typeof tempDir>;
let hub: Hub;
let envPath: string;

beforeEach(() => {
  fake = startFakeNanoGpt();
  dir = tempDir();
  envPath = join(dir.path, ".env");
  // Running as a fresh `.env` would start it: 127.0.0.1:4747, the key "test-key".
  hub = createHub(testConfig(dir.path, fake.baseUrl, { envPath, port: 4747, requestTimeoutMs: 180_000, allowedHosts: [] }));
});

afterEach(() => {
  hub.close();
  fake.stop();
  dir.cleanup();
});

async function call(method: string, path: string, body?: unknown) {
  const response = await hub.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json().catch(() => null)) as any };
}

const EXAMPLE = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");

describe("the .env text", () => {
  test("reads plain, quoted and commented lines", () => {
    expect(parseEnv("A=1\n# B=2\nexport C='x y'\nD=\"q\" # note\nE=plain # note\n")).toEqual({ A: "1", C: "x y", D: "q", E: "plain" });
  });

  test("changes a line in place, un-comments the example's, or adds one at the end", () => {
    const text = "# top\nNANOGPT_API_KEY=old\n\n# PORT=4747\n";
    expect(updateEnv(text, { NANOGPT_API_KEY: "new", PORT: "5000", HOST: "0.0.0.0" })).toBe("# top\nNANOGPT_API_KEY=new\n\nPORT=5000\nHOST=0.0.0.0\n");
  });

  test("an empty value comments the line out, and the default is used", () => {
    expect(updateEnv("PORT=5000\nPORT=6000\n", { PORT: null })).toBe("# PORT=\n");
    expect(updateEnv("A=1\n", { PORT: null })).toBe("A=1\n");
  });

  test("a value with unusual characters is quoted, so Bun reads it exactly", () => {
    const text = updateEnv("", { NANOGPT_API_KEY: "ab$c#d" });
    expect(text).toBe("NANOGPT_API_KEY='ab$c#d'\n");
    expect(parseEnv(text).NANOGPT_API_KEY).toBe("ab$c#d");
  });
});

describe("Server setup", () => {
  test("never sends the API key, only its last four characters", async () => {
    writeFileSync(envPath, "NANOGPT_API_KEY=sk-nano-secret-1234abcd\nPORT=4747\n");
    const { data } = await call("GET", "/api/hub/env");
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(data.apiKey).toEqual({ set: true, ending: "abcd" });
    expect(data.values.PORT).toBe("4747");
    expect(data.values.HOST).toBe("");
  });

  test("with no .env yet, saving makes one from .env.example, private to you", async () => {
    writeFileSync(join(dir.path, ".env.example"), EXAMPLE);
    expect((await call("GET", "/api/hub/env")).data).toMatchObject({ exists: false, apiKey: { set: false }, restartNeeded: false });
    const { status, data } = await call("PUT", "/api/hub/env", { apiKey: "sk-new-key-9999", values: { PORT: "5000" } });
    expect(status).toBe(200);
    expect(data).toMatchObject({ exists: true, apiKey: { set: true, ending: "9999" }, restartNeeded: true });
    const saved = readFileSync(envPath, "utf8");
    expect(saved).toContain("NANOGPT_API_KEY=sk-new-key-9999\n");
    expect(saved).toContain("\nPORT=5000\n");
    expect(saved).not.toContain("# PORT=4747");
    expect(saved).toContain("# Your nanoGPT API key"); // the example's comments are kept
    if (process.platform !== "win32") expect(statSync(envPath).mode & 0o077).toBe(0);
  });

  test("an empty key field keeps the key; restart is needed only while the file differs", async () => {
    writeFileSync(envPath, "NANOGPT_API_KEY=test-key\n# other notes\nMY_OWN=thing\n");
    expect((await call("GET", "/api/hub/env")).data.restartNeeded).toBe(false);
    let { data } = await call("PUT", "/api/hub/env", { apiKey: "", values: { DEVELOPER_PANEL: "1" } });
    expect(data.restartNeeded).toBe(true);
    expect(readFileSync(envPath, "utf8")).toBe("NANOGPT_API_KEY=test-key\n# other notes\nMY_OWN=thing\nDEVELOPER_PANEL=1\n");
    ({ data } = await call("PUT", "/api/hub/env", { values: { DEVELOPER_PANEL: "" } }));
    expect(data.restartNeeded).toBe(false);
  });

  test("wrong values are refused, and the file is left as it was", async () => {
    writeFileSync(envPath, "PORT=4747\n");
    for (const values of [{ PORT: "30OO" }, { PORT: "70000" }, { REQUEST_TIMEOUT_SECONDS: "0" }, { HOST: "a b" }, { DEVELOPER_PANEL: "yes" }, { NANOGPT_BASE_URL: "https://elsewhere" }, { DATA_DIR: "/" }]) {
      expect((await call("PUT", "/api/hub/env", { values })).status).toBe(400);
    }
    expect((await call("PUT", "/api/hub/env", { apiKey: "two words" })).status).toBe(400);
    expect((await call("PUT", "/api/hub/env", { apiKey: "it's" })).status).toBe(400);
    expect(readFileSync(envPath, "utf8")).toBe("PORT=4747\n");
  });

  test("changes must be sent as JSON, like the rest of the API", async () => {
    const response = await hub.fetch(new Request("http://localhost/api/hub/env", { method: "PUT", body: "values=x" }));
    expect(response.status).toBe(415);
  });

  test("without a .env path (tests), the route isn't there", async () => {
    hub.close();
    hub = createHub(testConfig(dir.path, fake.baseUrl));
    expect((await call("GET", "/api/hub/env")).status).toBe(404);
    expect(existsSync(envPath)).toBe(false);
  });
});
