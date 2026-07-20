import assert from "node:assert/strict";
import test from "node:test";
import { SyncRuntime, isRetryableStartupError } from "../src/admin-server.js";

function scheduler() {
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
      assert.ok(entry, "expected a scheduled retry");
      const [id, task] = entry;
      pending.delete(id);
      await task.callback();
    }
  };
}

function historyConfig() {
  return {
    bambu: {
      cloud: { accessToken: "token" },
      printerSerial: "PRINTER"
    },
    notion: {
      printTaskHistorySyncOnStart: true,
      printTaskHistoryMinIntervalMs: 0,
      printTaskHistoryLimit: 0,
      printTaskHistoryPageSize: 100
    },
    dryRun: false
  };
}

function historyRuntime({ fetchPrintTasks }) {
  const retryScheduler = scheduler();
  let stored = {};
  const notionSync = {
    async countPrintTaskPages() {
      return 0;
    },
    async syncCloudPrintTasks() {
      return { synced: 0, changed: 0, unchanged: 0 };
    }
  };
  const runtime = new SyncRuntime({
    readStoredConfig: async () => ({ ...stored }),
    writeStoredConfig: async (next) => {
      stored = { ...next };
    },
    fetchPrintTasks,
    setRetryTimeout: retryScheduler.set,
    clearRetryTimeout: retryScheduler.clear,
    taskHistoryRetryBaseMs: 10,
    taskHistoryRetryMaxMs: 100,
    random: () => 0.5
  });
  runtime.notionSync = notionSync;
  return { runtime, retryScheduler, stored: () => stored };
}

test("unknown fetch transport failures remain retryable unless a permanent cause is present", () => {
  assert.equal(
    isRetryableStartupError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("transport aborted"), { code: "UND_ERR_ABORTED" })
    })),
    true
  );
  assert.equal(isRetryableStartupError(Object.assign(new Error("conflict"), { status: 409 })), true);
  assert.equal(
    isRetryableStartupError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("bad certificate"), { code: "CERT_HAS_EXPIRED" })
    })),
    false
  );
});

test("print history request failure releases its run and retries without recording false success", async () => {
  let attempts = 0;
  const { runtime, retryScheduler, stored } = historyRuntime({
    fetchPrintTasks: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
        });
      }
      return [];
    }
  });

  await assert.rejects(runtime.syncPrintTaskHistory(historyConfig()), /fetch failed/);

  assert.equal(runtime.taskHistorySyncRunning, false);
  assert.equal(runtime.taskHistoryRun, null);
  assert.equal(retryScheduler.size, 1);
  assert.equal(stored().PRINT_TASK_HISTORY_LAST_SYNC_AT, undefined);

  await retryScheduler.runNext();

  assert.equal(attempts, 2);
  assert.equal(retryScheduler.size, 0);
  assert.equal(runtime.status().taskHistoryRetrying, false);
  assert.equal(runtime.status().taskHistoryRetryAttempt, 0);
  assert.match(stored().PRINT_TASK_HISTORY_LAST_SYNC_AT, /^\d{4}-\d{2}-\d{2}T/);
  await runtime.stop();
});

test("stopping the runtime aborts a hanging cloud history request without scheduling a retry", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const { runtime, retryScheduler } = historyRuntime({
    fetchPrintTasks: async ({ signal }) => {
      requestStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return [];
    }
  });

  const syncPromise = runtime.syncPrintTaskHistory(historyConfig());
  const rejected = assert.rejects(syncPromise, /runtime stopped/i);
  await started;
  await runtime.stop();
  await rejected;

  assert.equal(runtime.taskHistorySyncRunning, false);
  assert.equal(runtime.taskHistoryRun, null);
  assert.equal(retryScheduler.size, 0);
});

test("startup maintenance request failures retry without poisoning the maintenance lock", async () => {
  const retryScheduler = scheduler();
  let attempts = 0;
  const runtime = new SyncRuntime({
    setRetryTimeout: retryScheduler.set,
    clearRetryTimeout: retryScheduler.clear,
    random: () => 0.5
  });
  runtime.notionSync = {
    runStartupMaintenance() {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return Promise.resolve();
    }
  };

  await assert.rejects(runtime.runStartupMaintenance(), /fetch failed/);
  assert.equal(runtime.maintenanceRunning, false);
  assert.equal(runtime.maintenanceRun, null);
  assert.equal(retryScheduler.size, 1);

  await retryScheduler.runNext();
  assert.equal(attempts, 2);
  assert.equal(runtime.maintenanceRunning, false);
  assert.equal(runtime.status().maintenanceRetrying, false);
  assert.equal(runtime.status().maintenanceRetryAttempt, 0);
  await runtime.stop();
});

test("stopping detaches a maintenance request before it can schedule a stale retry", async () => {
  const retryScheduler = scheduler();
  let rejectMaintenance;
  const maintenance = new Promise((resolve, reject) => {
    rejectMaintenance = reject;
  });
  const runtime = new SyncRuntime({
    setRetryTimeout: retryScheduler.set,
    clearRetryTimeout: retryScheduler.clear
  });
  runtime.notionSync = { runStartupMaintenance: () => maintenance };

  const operation = runtime.runStartupMaintenance();
  const rejected = assert.rejects(operation, /runtime stopped/);
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.stop();
  rejectMaintenance(new TypeError("fetch failed"));
  await rejected;

  assert.equal(runtime.maintenanceRun, null);
  assert.equal(runtime.maintenanceRunning, false);
  assert.equal(retryScheduler.size, 0);
});

test("a detached old history write cannot clear or commit a newer run", async () => {
  const retryScheduler = scheduler();
  let stored = {};
  let fetchCalls = 0;
  let oldWriteStarted;
  const oldStarted = new Promise((resolve) => {
    oldWriteStarted = resolve;
  });
  let finishOldWrite;
  const oldWrite = new Promise((resolve) => {
    finishOldWrite = resolve;
  });
  const oldNotion = {
    async syncCloudPrintTasks() {
      oldWriteStarted();
      await oldWrite;
      return { synced: 1, changed: 1, unchanged: 0 };
    },
    async countPrintTaskPages() {
      return 1;
    }
  };
  const newNotion = {
    async countPrintTaskPages() {
      return 0;
    }
  };
  const runtime = new SyncRuntime({
    readStoredConfig: async () => ({ ...stored }),
    writeStoredConfig: async (next) => {
      stored = { ...next };
    },
    fetchPrintTasks: async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? [{ id: "old" }] : [];
    },
    setRetryTimeout: retryScheduler.set,
    clearRetryTimeout: retryScheduler.clear,
    taskHistoryStopWaitMs: 5
  });
  runtime.notionSync = oldNotion;

  const oldOperation = runtime.syncPrintTaskHistory(historyConfig());
  const oldRejected = assert.rejects(oldOperation, /runtime stopped/i);
  await oldStarted;
  await runtime.stop();

  runtime.notionSync = newNotion;
  await runtime.syncPrintTaskHistory(historyConfig());
  const newSuccessAt = stored.PRINT_TASK_HISTORY_LAST_SYNC_AT;
  finishOldWrite();
  await oldRejected;

  assert.equal(runtime.taskHistoryRun, null);
  assert.equal(runtime.taskHistorySyncRunning, false);
  assert.equal(stored.PRINT_TASK_HISTORY_LAST_SYNC_AT, newSuccessAt);
  assert.equal(retryScheduler.size, 0);
  await runtime.stop();
});
