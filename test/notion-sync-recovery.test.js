import assert from "node:assert/strict";
import test from "node:test";
import {
  NotionAmsSync,
  fetchExternalFile,
  fetchNotionResponse
} from "../src/notion-sync.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function logger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };
}

function bareSync() {
  return Object.create(NotionAmsSync.prototype);
}

test("Notion request deadlines include the complete response body", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchNotionResponse("https://api.notion.com/test", {}, {
      timeoutMs: 15,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        }
      }), { status: 200 })
    }),
    (error) => error.code === "ETIMEDOUT"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("Notion responses are bounded before the SDK parses them", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchNotionResponse("https://api.notion.com/test", {}, {
      maxBytes: 100,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        }
      }), {
        status: 200,
        headers: { "content-length": "1000" }
      })
    }),
    (error) => error.code === "RESPONSE_TOO_LARGE"
  );
  assert.equal(cancelled, true);
});

test("invalid successful Notion responses are classified as recoverable transport failures", async () => {
  await assert.rejects(
    fetchNotionResponse("https://api.notion.com/test", {}, {
      fetchImpl: async () => new Response("<html>proxy error</html>", { status: 200 })
    }),
    (error) => error.code === "INVALID_HTTP_RESPONSE" && error.status === 200 && error.cause instanceof SyntaxError
  );
});

test("an owner abort reaches an in-flight Notion transport request", async () => {
  const controller = new AbortController();
  const reason = new Error("runtime restarted");
  let requestSignal;
  const pending = fetchNotionResponse("https://api.notion.com/test", {}, {
    signal: controller.signal,
    fetchImpl: async (_input, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(requestSignal.aborted, true);
});

test("AMS queue drains the latest snapshot after the in-flight batch fails", async () => {
  const firstWrite = deferred();
  const sync = bareSync();
  const attempts = [];
  sync.amsSyncEnabled = true;
  sync.pendingTraySync = null;
  sync.traySyncRunning = false;
  sync.traySyncPromise = null;
  sync.logger = logger();
  sync.syncTrayBatch = async (trays) => {
    attempts.push(trays[0].uid);
    if (attempts.length === 1) await firstWrite.promise;
  };

  const first = sync.syncTrays([{ uid: "first" }]);
  await new Promise((resolve) => setImmediate(resolve));
  const latest = sync.syncTrays([{ uid: "latest" }]);
  firstWrite.reject(new TypeError("fetch failed"));

  await Promise.all([first, latest]);
  assert.deepEqual(attempts, ["first", "latest"]);
  assert.equal(sync.pendingTraySync, null);
  assert.equal(sync.traySyncRunning, false);
  assert.equal(sync.traySyncPromise, null);
});

test("printer status queue drains the latest state after the in-flight write fails", async () => {
  const firstWrite = deferred();
  const sync = bareSync();
  const attempts = [];
  sync.printTaskSyncEnabled = true;
  sync.taskDataSourceId = "tasks";
  sync.activeTasks = new Map();
  sync.config = {
    printTaskProgressStep: 5,
    printTaskUpdateIntervalMs: 120_000
  };
  sync.logger = logger();
  sync.printTaskRecordFromPrinterState = (state) => state;
  sync.upsertPrintTask = async (record) => {
    attempts.push(record.progress);
    if (attempts.length === 1) await firstWrite.promise;
  };

  const first = sync.syncPrinterStatus({
    taskKey: "task-1",
    status: "运行中",
    progress: 10,
    usedSlots: []
  });
  await new Promise((resolve) => setImmediate(resolve));
  const latest = sync.syncPrinterStatus({
    taskKey: "task-1",
    status: "已完成",
    progress: 100,
    usedSlots: []
  });
  firstWrite.reject(new TypeError("fetch failed"));

  await Promise.all([first, latest]);
  assert.deepEqual(attempts, [10, 100]);
  assert.deepEqual(
    {
      pendingWrite: sync.activeTasks.get("task-1").pendingWrite,
      writeInFlight: sync.activeTasks.get("task-1").writeInFlight,
      lastProgress: sync.activeTasks.get("task-1").lastProgress,
      lastStatus: sync.activeTasks.get("task-1").lastStatus
    },
    {
      pendingWrite: false,
      writeInFlight: false,
      lastProgress: 100,
      lastStatus: "已完成"
    }
  );
});

test("a failed printer status write remains pending when the same snapshot is retried", async () => {
  const sync = bareSync();
  const attempts = [];
  sync.printTaskSyncEnabled = true;
  sync.taskDataSourceId = "tasks";
  sync.activeTasks = new Map();
  sync.config = {
    printTaskProgressStep: 5,
    printTaskUpdateIntervalMs: 120_000
  };
  sync.logger = logger();
  sync.printTaskRecordFromPrinterState = (state) => state;
  sync.upsertPrintTask = async (record) => {
    attempts.push([...record.usedSlots]);
    if (record.usedSlots.includes("A2") && attempts.length === 2) {
      throw new TypeError("fetch failed");
    }
  };

  const base = {
    taskKey: "task-1",
    status: "运行中",
    progress: 10,
    usedSlots: ["A1"]
  };
  await sync.syncPrinterStatus(base);
  const changed = { ...base, usedSlots: ["A1", "A2"] };
  await assert.rejects(sync.syncPrinterStatus(changed), /fetch failed/);
  assert.equal(sync.activeTasks.get("task-1").pendingWrite, true);

  await sync.syncPrinterStatus(changed);
  assert.deepEqual(attempts, [["A1"], ["A1", "A2"], ["A1", "A2"]]);
  assert.equal(sync.activeTasks.get("task-1").pendingWrite, false);
});

test("print task initialization propagates parent database network failures", async () => {
  const networkError = new TypeError("fetch failed", {
    cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
  });
  const sync = new NotionAmsSync({ token: "test", dataSourceId: "source" }, logger());
  sync.client = {
    dataSources: {
      retrieve: async () => ({
        id: "source",
        properties: {},
        database_parent: { id: "database" }
      }),
      query: async () => ({ results: [] }),
      update: async () => ({})
    },
    databases: {
      retrieve: async () => {
        throw networkError;
      }
    }
  };

  await assert.rejects(
    sync.init({ deferMaintenance: true, enableAmsSync: false, enablePrintTaskSync: true }),
    (error) => error.cause === networkError
  );
  assert.equal(sync.taskDataSourceId, null);
});

test("print task initialization rejects a missing task data source", async () => {
  const sync = new NotionAmsSync({ token: "test", dataSourceId: "source" }, logger());
  sync.client = {
    dataSources: {
      retrieve: async () => ({}),
      query: async () => ({ results: [] }),
      update: async () => ({})
    }
  };
  sync.resolveDataSource = async () => ({ id: "source", properties: {} });
  sync.ensureTaskFilamentColorDataSource = async () => {};
  sync.ensureTaskDataSource = async () => {};

  await assert.rejects(
    sync.init({ deferMaintenance: true, enableAmsSync: false, enablePrintTaskSync: true }),
    /print task data source/i
  );
});

test("view inspection failures propagate instead of creating a duplicate view", async () => {
  const sync = bareSync();
  const timeout = Object.assign(new Error("view request timed out"), { code: "ETIMEDOUT" });
  let createCalls = 0;
  sync.taskDatabaseId = "database";
  sync.taskDataSourceId = "tasks";
  sync.logger = logger();
  sync.taskGalleryViewFilter = () => null;
  sync.taskGalleryViewSorts = () => [];
  sync.taskGalleryViewConfiguration = () => ({});
  sync.client = {
    views: {
      list: async () => ({ results: [{ id: "existing-view" }] }),
      retrieve: async () => {
        throw timeout;
      },
      update: async () => {},
      create: async () => {
        createCalls += 1;
      }
    }
  };

  await assert.rejects(sync.ensureTaskDefaultView(), (error) => error === timeout);
  assert.equal(createCalls, 0);
});

test("view configuration failures propagate so maintenance can retry", async () => {
  const sync = bareSync();
  const failure = new TypeError("fetch failed");
  sync.taskFilamentDatabaseId = "database";
  sync.taskFilamentDataSourceId = "filaments";
  sync.logger = logger();
  sync.taskFilamentCustomStatsFilter = () => null;
  sync.taskFilamentCustomStatsViewSorts = () => [];
  sync.taskFilamentCustomStatsTableConfiguration = () => ({});
  sync.taskFilamentCustomStatsChartConfiguration = () => null;
  sync.client = {
    views: {
      list: async () => ({ results: [] }),
      retrieve: async () => null,
      update: async () => {},
      create: async () => {
        throw failure;
      }
    }
  };

  await assert.rejects(sync.ensureTaskFilamentCustomStatsViews(), (error) => error === failure);
});

test("filament relation lookup failures propagate instead of writing an incomplete relation", async () => {
  const sync = bareSync();
  const timeout = Object.assign(new Error("relation lookup timed out"), { code: "ETIMEDOUT" });
  sync.findPageByUid = async () => {
    throw timeout;
  };

  await assert.rejects(sync.filamentPageIdsForUids(["uid-1"]), (error) => error === timeout);
});

test("failed icon attachment evicts the unconfirmed upload from cache", async () => {
  const sync = bareSync();
  const uploadId = "upload-1";
  sync.config = { createMissingPages: true };
  sync.logger = logger();
  sync.lastSignatures = new Map();
  sync.amsIconUploadCache = new Map([["single:#FF0000", uploadId]]);
  sync.findPageForTray = async () => ({ id: "page-1" });
  sync.buildTrayProperties = () => ({});
  sync.stableTraySignature = () => "signature";
  sync.pageMatchesTray = () => false;
  sync.updatePage = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    sync.syncTray(
      { uid: "tray-1", color: "#FF0000", colors: ["#FF0000"], colorType: "single" },
      new Date(),
      new Map([["#FF0000", "red"]])
    ),
    /fetch failed/
  );
  assert.equal(sync.amsIconUploadCache.has("single:#FF0000"), false);
});

test("external media downloads use an abort signal", async () => {
  const sync = bareSync();
  const originalFetch = globalThis.fetch;
  let requestSignal;
  sync.logger = logger();
  sync.client = {
    fileUploads: {
      create: async () => ({ id: "upload-1" }),
      send: async () => ({ id: "upload-1", status: "uploaded" }),
      retrieve: async () => ({ id: "upload-1", status: "uploaded" })
    }
  };

  globalThis.fetch = async (_url, options) => {
    requestSignal = options?.signal;
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
    };
  };

  try {
    const upload = await sync.importNotionFile("https://example.com/image.png", "image.png");
    assert.equal(upload.id, "upload-1");
    assert.ok(requestSignal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external media deadlines include a response body that never finishes", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchExternalFile("https://example.com/hanging.png", {
      timeoutMs: 15,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        }
      }), {
        status: 200,
        headers: { "content-type": "image/png" }
      })
    }),
    (error) => error.code === "ETIMEDOUT"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("external media downloads reject oversized bodies before buffering them", async () => {
  const sync = bareSync();
  const originalFetch = globalThis.fetch;
  let uploadCalls = 0;
  let bodyCancelled = false;
  sync.logger = logger();
  sync.client = {
    fileUploads: {
      create: async () => {
        uploadCalls += 1;
        return { id: "upload-1" };
      },
      send: async () => ({ id: "upload-1", status: "uploaded" })
    }
  };

  globalThis.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return name === "content-length" ? String(21 * 1024 * 1024) : "image/png";
      }
    },
    body: {
      cancel() {
        bodyCancelled = true;
      }
    },
    arrayBuffer: async () => {
      throw new Error("body should not be buffered");
    }
  });

  try {
    assert.equal(await sync.importNotionFile("https://example.com/huge.png", "huge.png"), null);
    assert.equal(bodyCancelled, true);
    assert.equal(uploadCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud print task batches stop before processing another task when aborted", async () => {
  const sync = bareSync();
  const controller = new AbortController();
  const abortReason = new Error("runtime restarted");
  const attempts = [];
  sync.printTaskSyncEnabled = true;
  sync.taskDataSourceId = "tasks";
  sync.taskFilamentSpecPageCache = new Map();
  sync.taskFilamentColorPageCache = new Map();
  sync.cloudTaskBatchMode = false;
  sync.logger = logger();
  sync.ensureTaskSchema = async () => {};
  sync.printTaskRecordFromCloudTask = (task) => task;
  sync.upsertPrintTask = async (record) => {
    assert.equal(sync.currentRequestSignal(), controller.signal);
    attempts.push(record.taskKey);
    if (record.taskKey === "first") controller.abort(abortReason);
    return { changed: true };
  };

  await assert.rejects(
    sync.syncCloudPrintTasks(
      [
        { taskKey: "first", startTime: "2026-07-01T00:00:00.000Z" },
        { taskKey: "second", startTime: "2026-07-02T00:00:00.000Z" }
      ],
      { signal: controller.signal }
    ),
    (error) => error === abortReason
  );
  assert.deepEqual(attempts, ["first"]);
  assert.equal(sync.cloudTaskBatchMode, false);
});
