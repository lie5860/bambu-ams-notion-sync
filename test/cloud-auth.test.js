import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCloudToken,
  loginWithPassword,
  saveCloudToken,
  sendVerificationCode
} from "../src/cloud-auth.js";

test("cloud tokens are serialized and atomically replaced with private permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bambu-token-test-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const tokenFile = join(directory, "token.json");

  const first = saveCloudToken(tokenFile, { accessToken: "first" });
  const second = saveCloudToken(tokenFile, { accessToken: "second" });
  await Promise.all([first, second]);

  assert.deepEqual(await loadCloudToken(tokenFile), { accessToken: "second" });
  assert.match(await readFile(tokenFile, "utf8"), /"second"/);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["token.json"]);
});

test("a pre-aborted cloud login operation does not start an HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const reason = new Error("login client disconnected");
  controller.abort(reason);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}");
  };

  try {
    await assert.rejects(
      sendVerificationCode({
        region: "global",
        account: "test@example.com",
        signal: controller.signal
      }),
      (error) => error === reason
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("device-list transport failures fail login instead of returning a partial token", async () => {
  const originalFetch = globalThis.fetch;
  const networkFailure = new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) return new Response(JSON.stringify({ accessToken: "token" }), { status: 200 });
    if (fetchCalls === 2) return new Response(JSON.stringify({ uid: "user" }), { status: 200 });
    throw networkFailure;
  };

  try {
    await assert.rejects(
      loginWithPassword({ region: "global", account: "test@example.com", password: "secret" }),
      (error) => error === networkFailure
    );
    assert.equal(fetchCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
