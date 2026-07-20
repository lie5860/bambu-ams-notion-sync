import assert from "node:assert/strict";
import test from "node:test";
import {
  CliSyncSupervisor,
  cliRetryDelay,
  handledAsyncCallback,
  isPermanentCliError
} from "../src/index.js";

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
      task.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function runtimeConfig({ ams = true, printHistory = false, cloud = null } = {}) {
  return {
    bambu: {
      cloud,
      printerName: "Test printer",
      printerSerial: "TEST123"
    },
    notion: {
      amsSyncEnabled: ams,
      printTaskHistorySyncOnStart: printHistory,
      printTaskHistoryLimit: 0,
      printTaskHistoryPageSize: 100
    },
    dryRun: true,
    logLevel: "error"
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached");
}

test("CLI keeps the original clean exit when no sync feature is enabled", async () => {
  let configRead = false;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => false,
    readConfig: () => {
      configRead = true;
      return runtimeConfig();
    },
    createRuntimeLogger: logger
  });

  await supervisor.run();
  assert.equal(configRead, false);
});

test("CLI supervisor retries transient Notion startup and stops the recovered MQTT client", async () => {
  const scheduler = createScheduler();
  const calls = { init: 0, start: 0, stop: 0 };
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => runtimeConfig(),
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      async init() {
        calls.init += 1;
        if (calls.init === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
          });
        }
      },
      async syncTrays() {}
    }),
    createBambuClient: () => ({
      start() {
        calls.start += 1;
      },
      stop() {
        calls.stop += 1;
      }
    }),
    setRetryTimeout: scheduler.set,
    clearRetryTimeout: scheduler.clear,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    random: () => 0.5
  });

  const running = supervisor.run();
  await waitFor(() => scheduler.size === 1);
  assert.equal(scheduler.first().delay, 100);

  await scheduler.runNext();
  await waitFor(() => calls.start === 1);
  supervisor.stop();
  await running;

  assert.equal(calls.init, 2);
  assert.equal(calls.stop, 1);
  assert.equal(scheduler.size, 0);
});

test("CLI supervisor keeps permanent configuration and authorization failures alive on a slow retry", async () => {
  const scheduler = createScheduler();
  let attempts = 0;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => {
      attempts += 1;
      throw Object.assign(new Error("Unauthorized"), { status: 401, code: "unauthorized" });
    },
    createRuntimeLogger: logger,
    setRetryTimeout: scheduler.set,
    clearRetryTimeout: scheduler.clear,
    permanentRetryMs: 9_000
  });

  const running = supervisor.run();
  await waitFor(() => scheduler.size === 1);
  assert.equal(scheduler.first().delay, 9_000);

  await scheduler.runNext();
  await waitFor(() => attempts === 2 && scheduler.size === 1);
  supervisor.stop();
  await running;

  assert.equal(attempts, 2);
  assert.equal(scheduler.size, 0);
});

test("stopping the CLI supervisor releases a startup attempt whose Notion init is still pending", async () => {
  let initStarted = false;
  let bambuStarted = false;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => runtimeConfig(),
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      init() {
        initStarted = true;
        return new Promise(() => {});
      }
    }),
    createBambuClient: () => ({
      start() {
        bambuStarted = true;
      },
      stop() {}
    })
  });

  const running = supervisor.run();
  await waitFor(() => initStarted);
  supervisor.stop();

  let timeout;
  await Promise.race([
    running,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("supervisor did not stop")), 100);
    })
  ]).finally(() => clearTimeout(timeout));
  assert.equal(bambuStarted, false);
});

test("CLI print history retries a runtime request failure instead of exiting", async () => {
  const scheduler = createScheduler();
  let fetchAttempts = 0;
  let syncedTasks = null;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => runtimeConfig({
      ams: false,
      printHistory: true,
      cloud: { accessToken: "token" }
    }),
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      async init() {},
      async syncCloudPrintTasks(tasks) {
        syncedTasks = tasks;
      }
    }),
    fetchPrintTasks: async () => {
      fetchAttempts += 1;
      if (fetchAttempts === 1) throw Object.assign(new Error("offline"), { code: "ENETUNREACH" });
      return [{ id: "task-1" }];
    },
    setRetryTimeout: scheduler.set,
    clearRetryTimeout: scheduler.clear,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    random: () => 0.5
  });

  const running = supervisor.run();
  await waitFor(() => scheduler.size === 1);
  await scheduler.runNext();
  await running;

  assert.equal(fetchAttempts, 2);
  assert.deepEqual(syncedTasks, [{ id: "task-1" }]);
});

test("CLI print history rebuilds runtime configuration after an authorization failure", async () => {
  const scheduler = createScheduler();
  let configReads = 0;
  const fetchedTokens = [];
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => {
      configReads += 1;
      return runtimeConfig({
        ams: false,
        printHistory: true,
        cloud: { accessToken: configReads === 1 ? "expired" : "refreshed" }
      });
    },
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      async init() {},
      async syncCloudPrintTasks() {}
    }),
    fetchPrintTasks: async ({ cloud }) => {
      fetchedTokens.push(cloud.accessToken);
      if (cloud.accessToken === "expired") {
        throw Object.assign(new Error("Unauthorized"), { status: 401, code: "unauthorized" });
      }
      return [];
    },
    setRetryTimeout: scheduler.set,
    clearRetryTimeout: scheduler.clear,
    permanentRetryMs: 9_000
  });

  const running = supervisor.run();
  await waitFor(() => scheduler.size === 1);
  assert.equal(scheduler.first().delay, 9_000);
  await scheduler.runNext();
  await running;

  assert.equal(configReads, 2);
  assert.deepEqual(fetchedTokens, ["expired", "refreshed"]);
});

test("stopping the CLI supervisor aborts an in-flight print history request", async () => {
  let requestStarted = false;
  let requestAborted = false;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => runtimeConfig({
      ams: false,
      printHistory: true,
      cloud: { accessToken: "token" }
    }),
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      async init() {},
      async syncCloudPrintTasks() {}
    }),
    fetchPrintTasks: ({ signal }) => new Promise((resolve, reject) => {
      requestStarted = true;
      signal.addEventListener("abort", () => {
        requestAborted = true;
        reject(signal.reason);
      }, { once: true });
    })
  });

  const running = supervisor.run();
  await waitFor(() => requestStarted);
  supervisor.stop();
  await running;

  assert.equal(requestAborted, true);
});

test("stopping the CLI supervisor releases an in-flight Notion history write", async () => {
  let historyWriteStarted = false;
  const supervisor = new CliSyncSupervisor({
    featuresEnabled: () => true,
    readConfig: () => runtimeConfig({
      ams: false,
      printHistory: true,
      cloud: { accessToken: "token" }
    }),
    createRuntimeLogger: logger,
    createNotionSync: () => ({
      async init() {},
      syncCloudPrintTasks() {
        historyWriteStarted = true;
        return new Promise(() => {});
      }
    }),
    fetchPrintTasks: async () => [{ id: "task-1" }]
  });

  const running = supervisor.run();
  await waitFor(() => historyWriteStarted);
  supervisor.stop();

  let timeout;
  await Promise.race([
    running,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("supervisor did not stop")), 100);
    })
  ]).finally(() => clearTimeout(timeout));
});

test("callback adapter turns synchronous throws into observed promise rejections", async () => {
  const expected = new Error("synchronous callback failure");
  const callback = handledAsyncCallback(() => {
    throw expected;
  });

  let operation;
  assert.doesNotThrow(() => {
    operation = callback();
  });
  await assert.rejects(operation, expected);
});

test("CLI retry classification keeps unknown failures recoverable and slows permanent failures", () => {
  assert.equal(isPermanentCliError(Object.assign(new Error("Unauthorized"), { status: 401 })), true);
  assert.equal(isPermanentCliError(new Error("Missing required env: NOTION_TOKEN")), true);
  assert.equal(isPermanentCliError(Object.assign(new Error("socket"), { code: "ECONNABORTED" })), false);
  assert.equal(isPermanentCliError(Object.assign(new Error("busy"), { status: 503 })), false);
  assert.equal(cliRetryDelay(1, { baseMs: 100, maxMs: 1_000, random: () => 0.5 }), 100);
  assert.equal(cliRetryDelay(20, { baseMs: 100, maxMs: 1_000, random: () => 0.5 }), 1_000);
});
