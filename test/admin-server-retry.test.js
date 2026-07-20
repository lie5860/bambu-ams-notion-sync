import assert from "node:assert/strict";
import test from "node:test";
import {
  SyncRuntime,
  isRetryableStartupError,
  startupRetryDelay
} from "../src/admin-server.js";

function createScheduler() {
  let nextId = 0;
  const pending = new Map();

  return {
    set(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    get size() {
      return pending.size;
    },
    first() {
      return pending.values().next().value;
    },
    async runNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, "expected a pending retry");
      const [id, task] = entry;
      pending.delete(id);
      await task.callback();
    }
  };
}

function transientFetchError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
  });
}

function parsedConfig() {
  return {
    bambu: {
      printerName: "Test printer",
      printerSerial: "TEST123"
    },
    notion: {
      amsSyncEnabled: true,
      printTaskHistorySyncOnStart: false
    },
    dryRun: true,
    logLevel: "error"
  };
}

function createRuntime({
  init,
  parseConfig = parsedConfig,
  storedConfig = {
    AMS_SYNC_ENABLED: "true",
    PRINT_TASK_HISTORY_SYNC_ON_START: "false"
  }
} = {}) {
  const scheduler = createScheduler();
  const calls = { init: 0, bambuStart: 0, bambuStop: 0 };
  const runtime = new SyncRuntime({
    readStoredConfig: async () => storedConfig,
    parseConfig,
    createNotionSync: () => ({
      async init() {
        calls.init += 1;
        await init?.(calls.init);
      },
      async runStartupMaintenance() {},
      async syncTrays() {}
    }),
    createBambuClient: () => ({
      start() {
        calls.bambuStart += 1;
      },
      stop() {
        calls.bambuStop += 1;
      },
      status() {
        return { connected: false };
      },
      requestManualSync() {
        return true;
      }
    }),
    setRetryTimeout: scheduler.set,
    clearRetryTimeout: scheduler.clear,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    random: () => 0.5
  });

  return { runtime, scheduler, calls };
}

test("retries startup after a transient Notion failure and starts after recovery", async () => {
  let online = false;
  const { runtime, scheduler, calls } = createRuntime({
    init: async () => {
      if (!online) throw transientFetchError();
    }
  });

  await runtime.restart();

  assert.equal(calls.init, 1);
  assert.equal(calls.bambuStart, 0);
  assert.equal(scheduler.size, 1);
  assert.deepEqual(
    {
      running: runtime.status().running,
      starting: runtime.status().starting,
      retrying: runtime.status().retrying,
      retryAttempt: runtime.status().startupRetryAttempt,
      lastError: runtime.status().lastError
    },
    {
      running: false,
      starting: false,
      retrying: true,
      retryAttempt: 1,
      lastError: "fetch failed"
    }
  );

  online = true;
  await scheduler.runNext();

  assert.equal(calls.init, 2);
  assert.equal(calls.bambuStart, 1);
  assert.equal(scheduler.size, 0);
  assert.equal(runtime.status().running, true);
  assert.equal(runtime.status().retrying, false);
  assert.equal(runtime.status().startupRetryAttempt, 0);
  assert.equal(runtime.status().lastError, "");
  await runtime.stop();
});

test("stop cancels a pending startup retry", async () => {
  const { runtime, scheduler, calls } = createRuntime({
    init: async () => {
      throw transientFetchError();
    }
  });

  await runtime.restart();
  assert.equal(scheduler.size, 1);

  await runtime.stop();

  assert.equal(scheduler.size, 0);
  assert.equal(runtime.status().retrying, false);
  assert.equal(runtime.status().startupRetryAttempt, 0);
  assert.equal(calls.init, 1);
});

test("keeps one retry scheduled and backs off while the network stays offline", async () => {
  const { runtime, scheduler, calls } = createRuntime({
    init: async () => {
      throw transientFetchError();
    }
  });

  await runtime.restart();
  assert.equal(scheduler.size, 1);
  assert.equal(scheduler.first().delay, 100);

  await scheduler.runNext();
  assert.equal(calls.init, 2);
  assert.equal(scheduler.size, 1);
  assert.equal(scheduler.first().delay, 200);
  assert.equal(runtime.status().startupRetryAttempt, 2);

  await scheduler.runNext();
  assert.equal(calls.init, 3);
  assert.equal(scheduler.size, 1);
  assert.equal(scheduler.first().delay, 400);
  assert.equal(runtime.status().startupRetryAttempt, 3);
  await runtime.stop();
});

test("a manual restart supersedes its previously scheduled retry", async () => {
  let online = false;
  const { runtime, scheduler, calls } = createRuntime({
    init: async () => {
      if (!online) throw transientFetchError();
    }
  });

  await runtime.restart();
  const staleRetry = scheduler.first().callback;
  online = true;

  await runtime.restart();
  await staleRetry();

  assert.equal(calls.init, 2);
  assert.equal(calls.bambuStart, 1);
  assert.equal(scheduler.size, 0);
  assert.equal(runtime.status().running, true);
  await runtime.stop();
});

test("an in-flight stale retry cannot overwrite a newer manual restart", async () => {
  let rejectInFlightRetry;
  const inFlightRetry = new Promise((resolve, reject) => {
    rejectInFlightRetry = reject;
  });
  const { runtime, scheduler, calls } = createRuntime({
    init: async (attempt) => {
      if (attempt === 1) throw transientFetchError();
      if (attempt === 2) await inFlightRetry;
    }
  });

  await runtime.restart();
  const automaticRestart = scheduler.runNext();
  while (calls.init < 2) await new Promise((resolve) => setImmediate(resolve));

  const manualRestart = runtime.restart();
  rejectInFlightRetry(transientFetchError());
  await automaticRestart;
  await manualRestart;

  assert.equal(calls.init, 3);
  assert.equal(calls.bambuStart, 1);
  assert.equal(scheduler.size, 0);
  assert.equal(runtime.status().running, true);
  assert.equal(runtime.status().retrying, false);
  await runtime.stop();
});

test("runs a queued manual print-history sync after startup recovers", async () => {
  let online = false;
  const historySyncOptions = [];
  const { runtime, scheduler } = createRuntime({
    storedConfig: {
      AMS_SYNC_ENABLED: "false",
      PRINT_TASK_HISTORY_SYNC_ON_START: "true"
    },
    parseConfig: () => ({
      bambu: {
        printerName: "Test printer",
        printerSerial: "TEST123",
        cloud: null
      },
      notion: {
        amsSyncEnabled: false,
        printTaskHistorySyncOnStart: true
      },
      dryRun: true,
      logLevel: "error"
    }),
    init: async () => {
      if (!online) throw transientFetchError();
    }
  });
  runtime.syncPrintTaskHistory = async (_config, options) => {
    historySyncOptions.push(options);
  };

  await runtime.restart();
  const manualResult = await runtime.manualSync();
  assert.equal(manualResult.pending, true);
  assert.equal(runtime.status().pendingManualSync, true);

  online = true;
  await scheduler.runNext();

  assert.deepEqual(historySyncOptions, [{ ignoreCooldown: true }]);
  assert.equal(runtime.status().running, true);
  assert.equal(runtime.status().pendingManualSync, false);
  await runtime.stop();
});

test("stop prevents an in-flight retry from reviving the service", async () => {
  const inFlightRetry = new Promise(() => {});
  const { runtime, scheduler, calls } = createRuntime({
    init: async (attempt) => {
      if (attempt === 1) throw transientFetchError();
      await inFlightRetry;
    }
  });

  await runtime.restart();
  const automaticRestart = scheduler.runNext();
  while (calls.init < 2) await new Promise((resolve) => setImmediate(resolve));

  await runtime.stop();
  await Promise.race([
    automaticRestart,
    new Promise((_, reject) => setTimeout(() => reject(new Error("aborted startup did not release")), 100))
  ]);

  assert.equal(calls.init, 2);
  assert.equal(calls.bambuStart, 0);
  assert.equal(scheduler.size, 0);
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().retrying, false);
});

test("does not retry setup or permanent API errors", async (t) => {
  await t.test("missing configuration", async () => {
    const { runtime, scheduler } = createRuntime({
      parseConfig: () => {
        throw new Error("Missing required env: NOTION_TOKEN");
      }
    });

    await runtime.restart();
    assert.equal(scheduler.size, 0);
    assert.equal(runtime.status().retrying, false);
  });

  await t.test("unauthorized response", async () => {
    const { runtime, scheduler } = createRuntime({
      init: async () => {
        throw Object.assign(new Error("Unauthorized"), { status: 401, code: "unauthorized" });
      }
    });

    await runtime.restart();
    assert.equal(scheduler.size, 0);
    assert.equal(runtime.status().retrying, false);
  });

  await t.test("a permanent error after a transient failure clears retry state", async () => {
    const { runtime, scheduler } = createRuntime({
      init: async (attempt) => {
        if (attempt === 1) throw transientFetchError();
        throw Object.assign(new Error("Unauthorized"), { status: 401, code: "unauthorized" });
      }
    });

    await runtime.restart();
    await scheduler.runNext();
    assert.equal(scheduler.size, 0);
    assert.equal(runtime.status().retrying, false);
    assert.equal(runtime.status().startupRetryAttempt, 0);
  });
});

test("classifies transient failures and caps exponential backoff", () => {
  assert.equal(isRetryableStartupError(transientFetchError()), true);
  assert.equal(isRetryableStartupError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableStartupError(Object.assign(new Error("busy"), { status: 503 })), true);
  assert.equal(isRetryableStartupError(Object.assign(new Error("Unauthorized"), { status: 401 })), false);
  assert.equal(
    isRetryableStartupError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate name mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })
    })),
    false
  );
  assert.equal(
    isRetryableStartupError(new Error("Notion target lookup failed", {
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("certificate name mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })
      })
    })),
    false
  );
  assert.equal(startupRetryDelay(1, { baseMs: 100, maxMs: 1_000, random: () => 0.5 }), 100);
  assert.equal(startupRetryDelay(2, { baseMs: 100, maxMs: 1_000, random: () => 0.5 }), 200);
  assert.equal(startupRetryDelay(20, { baseMs: 100, maxMs: 1_000, random: () => 0.5 }), 1_000);
});
