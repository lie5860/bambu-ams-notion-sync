import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { awaitWithSignal, parseBody, readResponseText, withTimeout } from "../src/http.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("withTimeout bounds an operation that never settles", async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), { timeoutMs: 15 }),
    (error) => error.code === "ETIMEDOUT" && error.name === "TimeoutError"
  );
});

test("one deadline covers a response body that never finishes", async () => {
  let cancelled = false;
  await assert.rejects(
    withTimeout(async (signal) => {
      const response = new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        }
      }));
      return readResponseText(response, { signal });
    }, { timeoutMs: 15 }),
    (error) => error.code === "ETIMEDOUT"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("a caller abort is preserved instead of being reported as a timeout", async () => {
  const controller = new AbortController();
  const reason = new Error("request owner stopped");
  const pending = withTimeout(() => new Promise(() => {}), {
    timeoutMs: 1_000,
    signal: controller.signal
  });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("an already-aborted signal still observes a previously-created operation", async () => {
  const controller = new AbortController();
  const reason = new Error("request owner stopped");
  const inner = deferred();
  controller.abort(reason);

  const pending = awaitWithSignal(inner.promise, controller.signal);
  await assert.rejects(pending, (error) => error === reason);
  inner.reject(new Error("late internal failure"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("withTimeout does not start an operation whose owner already stopped", async () => {
  const controller = new AbortController();
  const reason = new Error("already stopped");
  controller.abort(reason);
  let calls = 0;

  await assert.rejects(
    withTimeout(() => {
      calls += 1;
    }, { signal: controller.signal }),
    (error) => error === reason
  );
  assert.equal(calls, 0);
});

test("response text is size-limited before buffering a declared oversized body", async () => {
  let cancelled = false;
  const response = {
    headers: { get: () => "1000" },
    body: {
      cancel() {
        cancelled = true;
      }
    },
    text: async () => {
      throw new Error("must not buffer an oversized response");
    }
  };

  await assert.rejects(
    readResponseText(response, { maxBytes: 100 }),
    (error) => error.code === "RESPONSE_TOO_LARGE"
  );
  assert.equal(cancelled, true);
});

test("parseBody rejects an HTTP request that disconnects before completion", async () => {
  const request = new EventEmitter();
  request.complete = false;
  request.aborted = false;
  request.destroyed = false;
  request.off = request.removeListener;

  const parsed = parseBody(request);
  request.emit("aborted");
  await assert.rejects(parsed, /aborted/i);
  assert.equal(request.listenerCount("data"), 0);
  assert.equal(request.listenerCount("end"), 0);
});
