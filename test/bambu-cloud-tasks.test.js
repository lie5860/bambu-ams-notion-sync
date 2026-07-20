import assert from "node:assert/strict";
import test from "node:test";
import { fetchCloudPrintTasks } from "../src/bambu-cloud-tasks.js";

const cloud = { region: "global", accessToken: "test-token" };

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

test("times out a fetch that never settles", async () => {
  let requestSignal;
  const fetchImpl = (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    fetchCloudPrintTasks({
      cloud,
      printerSerial: "PRINTER-1",
      fetchImpl,
      requestTimeoutMs: 15
    }),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.ok(error.cause);
      return true;
    }
  );
  assert.equal(requestSignal.aborted, true);
});

test("times out a response body that never settles", async () => {
  let bodyCancelled = false;
  const body = new ReadableStream({
    cancel() {
      bodyCancelled = true;
    }
  });

  await assert.rejects(
    fetchCloudPrintTasks({
      cloud,
      printerSerial: "PRINTER-1",
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      bodyTimeoutMs: 15
    }),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.status, 200);
      assert.ok(error.cause);
      return true;
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bodyCancelled, true);
});

test("honors an abort signal supplied by the caller", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("runtime stopped"), { code: "RUNTIME_STOPPED" });
  const pending = fetchCloudPrintTasks({
    cloud,
    printerSerial: "PRINTER-1",
    fetchImpl: () => new Promise(() => {}),
    signal: controller.signal,
    requestTimeoutMs: 1_000
  });

  controller.abort(reason);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.cause, reason);
    return true;
  });
});

test("does not call fetch when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  let fetchCalls = 0;

  await assert.rejects(
    fetchCloudPrintTasks({
      cloud,
      printerSerial: "PRINTER-1",
      signal: controller.signal,
      fetchImpl: () => {
        fetchCalls += 1;
        return new Promise(() => {});
      }
    }),
    (error) => error.code === "ABORT_ERR"
  );
  assert.equal(fetchCalls, 0);
});

test("observes a body rejection when abort wins between headers and body reading", async () => {
  const controller = new AbortController();
  const reason = new Error("runtime stopped between response phases");
  const fetchResult = {};
  fetchResult.promise = new Promise((resolve) => {
    fetchResult.resolve = resolve;
  });
  const innerFailure = new Error("late body failure");
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    body: null,
    text: () => Promise.reject(innerFailure)
  };

  const pending = fetchCloudPrintTasks({
    cloud,
    printerSerial: "PRINTER-1",
    signal: controller.signal,
    fetchImpl: () => fetchResult.promise
  });
  fetchResult.resolve(response);
  queueMicrotask(() => controller.abort(reason));

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.cause, reason);
    return true;
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test("preserves network causes and HTTP status without retrying", async (t) => {
  await t.test("network cause", async () => {
    const socketError = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const fetchError = new TypeError("fetch failed", { cause: socketError });
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        fetchImpl: async () => {
          throw fetchError;
        }
      }),
      (error) => error.code === "ECONNRESET" && error.cause === fetchError
    );
  });

  await t.test("HTTP status", async () => {
    let fetchCalls = 0;
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        fetchImpl: async () => {
          fetchCalls += 1;
          return jsonResponse({ message: "try later" }, { status: 503 });
        }
      }),
      (error) => error.code === "BAMBU_CLOUD_HTTP_ERROR" && error.status === 503
    );
    assert.equal(fetchCalls, 1);
  });
});

test("rejects invalid successful response schemas", async (t) => {
  await t.test("missing hits", async () => {
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        fetchImpl: async () => jsonResponse({ total: 1 })
      }),
      (error) => error.code === "BAMBU_CLOUD_INVALID_SCHEMA" && error.status === 200
    );
  });

  await t.test("invalid total", async () => {
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        fetchImpl: async () => jsonResponse({ hits: [], total: -1 })
      }),
      (error) => error.code === "BAMBU_CLOUD_INVALID_PAGINATION" && error.status === 200
    );
  });

  await t.test("page larger than requested limit", async () => {
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        pageSize: 1,
        fetchImpl: async () => jsonResponse({ hits: [{ id: 1 }, { id: 2 }], total: 2 })
      }),
      (error) => error.code === "BAMBU_CLOUD_INVALID_PAGINATION" && error.status === 200
    );
  });
});

test("caps response bytes, task count, and pagination", async (t) => {
  await t.test("response bytes", async () => {
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        maxResponseBytes: 8,
        fetchImpl: async () => jsonResponse({ hits: [], total: 0 })
      }),
      (error) => error.code === "BAMBU_CLOUD_RESPONSE_TOO_LARGE" && error.status === 200
    );
  });

  await t.test("declared oversized response is cancelled", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      }
    });
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        maxResponseBytes: 8,
        fetchImpl: async () => new Response(body, {
          status: 200,
          headers: { "content-length": "100" }
        })
      }),
      (error) => error.code === "BAMBU_CLOUD_RESPONSE_TOO_LARGE" && error.status === 200
    );
    assert.equal(cancelled, true);
  });

  await t.test("a hanging oversized-body cancellation still times out", async () => {
    const body = new ReadableStream({
      cancel() {
        return new Promise(() => {});
      }
    });
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        maxResponseBytes: 8,
        bodyTimeoutMs: 15,
        fetchImpl: async () => new Response(body, {
          status: 200,
          headers: { "content-length": "100" }
        })
      }),
      (error) => error.code === "ETIMEDOUT" && error.cause?.code === "ETIMEDOUT"
    );
  });

  await t.test("caller abort wins over a hanging oversized-body cancellation", async () => {
    let markCancelStarted;
    const cancelStarted = new Promise((resolve) => {
      markCancelStarted = resolve;
    });
    const body = new ReadableStream({
      cancel() {
        markCancelStarted();
        return new Promise(() => {});
      }
    });
    const controller = new AbortController();
    const reason = new Error("runtime stopped");
    const pending = fetchCloudPrintTasks({
      cloud,
      printerSerial: "PRINTER-1",
      maxResponseBytes: 8,
      signal: controller.signal,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-length": "100" }
      })
    });

    await cancelStarted;
    controller.abort(reason);
    await assert.rejects(
      pending,
      (error) => error.code === "ABORT_ERR" && error.cause === reason
    );
  });

  await t.test("task count", async () => {
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        maxTasks: 1,
        fetchImpl: async () => jsonResponse({ hits: [{ id: 1 }], total: 2 })
      }),
      (error) => error.code === "BAMBU_CLOUD_MAX_TASKS_EXCEEDED" && error.status === 200
    );
  });

  await t.test("page count", async () => {
    const fetchImpl = async (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return jsonResponse({ hits: [{ id: offset + 1 }], total: 3 });
    };
    await assert.rejects(
      fetchCloudPrintTasks({
        cloud,
        printerSerial: "PRINTER-1",
        pageSize: 1,
        maxPages: 2,
        fetchImpl
      }),
      (error) => error.code === "BAMBU_CLOUD_MAX_PAGES_EXCEEDED"
    );
  });
});

test("fetches normal pagination with bounded GET requests", async () => {
  const calls = [];
  const allTasks = [
    { id: 1, endTime: 100 },
    { id: 2, endTime: 200 },
    { id: 3, endTime: 300 },
    { id: 4, endTime: 400 },
    { id: 5, endTime: 500 }
  ];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get("offset"));
    const requestLimit = Number(parsed.searchParams.get("limit"));
    calls.push({ offset, requestLimit, options });
    return jsonResponse({
      hits: allTasks.slice(offset, offset + requestLimit),
      total: allTasks.length
    });
  };

  const tasks = await fetchCloudPrintTasks({
    cloud,
    printerSerial: "PRINTER-1",
    pageSize: 2,
    fetchImpl
  });

  assert.deepEqual(tasks, allTasks);
  assert.deepEqual(calls.map(({ offset, requestLimit }) => ({ offset, requestLimit })), [
    { offset: 0, requestLimit: 2 },
    { offset: 2, requestLimit: 2 },
    { offset: 4, requestLimit: 2 }
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.headers.Authorization, "Bearer test-token");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("small configured pages can still reach the bounded task limit", async () => {
  let calls = 0;
  const total = 201;
  const tasks = await fetchCloudPrintTasks({
    cloud,
    printerSerial: "PRINTER-1",
    pageSize: 1,
    maxTasks: total,
    fetchImpl: async (url) => {
      calls += 1;
      const offset = Number(new URL(url).searchParams.get("offset"));
      return jsonResponse({ hits: [{ id: offset }], total });
    }
  });

  assert.equal(tasks.length, total);
  assert.equal(calls, total);
});
