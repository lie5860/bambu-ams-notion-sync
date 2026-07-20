import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BambuMqttClient } from "../src/bambu.js";

class ManualScheduler {
  constructor() {
    this.nextId = 1;
    this.records = [];
  }

  setTimeout = (callback, delay) => this.add("timeout", callback, delay);
  clearTimeout = (record) => {
    if (record) record.cancelled = true;
  };
  setInterval = (callback, delay) => this.add("interval", callback, delay);
  clearInterval = (record) => {
    if (record) record.cancelled = true;
  };

  add(type, callback, delay) {
    const record = {
      id: this.nextId++,
      type,
      callback,
      delay,
      cancelled: false,
      fired: false
    };
    this.records.push(record);
    return record;
  }

  pendingTimeouts() {
    return this.records.filter((record) => record.type === "timeout" && !record.cancelled && !record.fired);
  }

  runNextTimeout() {
    const record = this.pendingTimeouts()[0];
    assert.ok(record, "expected a pending timeout");
    this.run(record);
    return record;
  }

  run(record, { force = false } = {}) {
    if (!force && (record.cancelled || record.fired)) return;
    record.fired = true;
    record.callback();
  }
}

class FakeMqttClient extends EventEmitter {
  constructor(subscribeImpl = (_topic, callback) => callback(null)) {
    super();
    this.connected = false;
    this.subscribeImpl = subscribeImpl;
    this.subscribeCalls = 0;
    this.publishCalls = [];
    this.endCalls = 0;
  }

  subscribe(topic, callback) {
    this.subscribeCalls += 1;
    return this.subscribeImpl(topic, callback, this.subscribeCalls);
  }

  publish(topic, payload, callback) {
    this.publishCalls.push({ topic, payload });
    callback?.(null);
  }

  end(force) {
    assert.equal(force, true);
    this.connected = false;
    this.endCalls += 1;
  }

  connect() {
    this.connected = true;
    this.emit("connect");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function config(overrides = {}) {
  return {
    connectionMode: "local",
    printerIp: "127.0.0.1",
    printerSerial: "SERIAL",
    accessCode: "secret",
    uidFields: ["tray_uuid", "tag_uid"],
    defaultSpoolWeightGrams: 1000,
    correctRemainForTrayWeight: true,
    pushAllOnStart: false,
    pushAllIntervalMs: 0,
    syncDebounceMs: 0,
    rejectUnauthorized: false,
    ...overrides
  };
}

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function amsPayload(uid, remain = 50) {
  return Buffer.from(JSON.stringify({
    print: {
      ams: {
        ams: [{
          id: "0",
          tray: [{ id: "0", tray_uuid: uid, tray_type: "PLA", remain }]
        }]
      }
    }
  }));
}

function printPayload(taskId, progress, state = "RUNNING") {
  return Buffer.from(JSON.stringify({
    print: { task_id: taskId, mc_percent: progress, gcode_state: state }
  }));
}

function harness({
  onTrays = async () => {},
  onPrinterStatus = null,
  onReady = null,
  subscribeImpl,
  configOverrides = {},
  runtimeOverrides = {}
} = {}) {
  const scheduler = new ManualScheduler();
  const mqttClient = new FakeMqttClient(subscribeImpl);
  const bambu = new BambuMqttClient(
    config(configOverrides),
    logger(),
    onTrays,
    onPrinterStatus,
    onReady,
    {
      mqttConnect: () => mqttClient,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
      retryBaseMs: 10,
      retryMaxMs: 40,
      random: () => 0.5,
      ...runtimeOverrides
    }
  );
  bambu.start();
  mqttClient.connect();
  return { bambu, mqttClient, scheduler };
}

test("contains malformed MQTT messages and synchronous callback failures", async () => {
  let printerCalls = 0;
  const { bambu, mqttClient, scheduler } = harness({
    onReady: () => {
      throw new Error("ready failed");
    },
    onPrinterStatus: () => {
      printerCalls += 1;
      if (printerCalls === 1) throw new Error("status failed");
      return undefined;
    }
  });

  assert.doesNotThrow(() => mqttClient.emit("message", "topic", Buffer.from("null")));
  assert.doesNotThrow(() => mqttClient.emit(
    "message",
    "topic",
    Buffer.from('{"print":{"ams":{"ams":[null]}}}')
  ));
  assert.doesNotThrow(() => mqttClient.emit("message", "topic", printPayload("task-a", 1)));
  await drainMicrotasks();

  assert.equal(printerCalls, 2);
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 10);
  scheduler.runNextTimeout();
  await drainMicrotasks();
  assert.equal(printerCalls, 3);
  assert.equal(bambu.status().retryingPrinterStatus, false);
  bambu.stop();
});

test("retries a failed AMS callback without another MQTT message", async () => {
  const calls = [];
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: (trays) => {
      calls.push(trays[0].uid);
      if (calls.length === 1) return Promise.reject(null);
      return undefined;
    }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  assert.equal(scheduler.runNextTimeout().delay, 0);
  await drainMicrotasks();
  assert.deepEqual(calls, ["A"]);
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 10);

  scheduler.runNextTimeout();
  await drainMicrotasks();
  assert.deepEqual(calls, ["A", "A"]);
  assert.equal(bambu.status().retryingTrays, false);
  assert.notEqual(bambu.lastTraySnapshotSignature, "");
  bambu.stop();
});

test("AMS synchronization is serialized and keeps only the latest queued snapshot", async () => {
  const first = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: async (trays) => {
      calls.push(trays[0].uid);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls.length === 1) await first.promise;
      active -= 1;
    }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  scheduler.runNextTimeout();
  await drainMicrotasks();
  mqttClient.emit("message", "topic", amsPayload("B"));
  mqttClient.emit("message", "topic", amsPayload("C"));
  assert.deepEqual(calls, ["A"]);

  first.resolve();
  await drainMicrotasks();
  scheduler.runNextTimeout();
  await drainMicrotasks();
  assert.deepEqual(calls, ["A", "C"]);
  assert.equal(maxActive, 1);
  bambu.stop();
});

test("replays a reverted AMS state after an in-flight newer state succeeds", async () => {
  const writeY = deferred();
  const calls = [];
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: async (trays) => {
      const uid = trays[0].uid;
      calls.push(uid);
      if (uid === "Y") await writeY.promise;
    }
  });

  mqttClient.emit("message", "topic", amsPayload("X"));
  scheduler.runNextTimeout();
  await drainMicrotasks();
  mqttClient.emit("message", "topic", amsPayload("Y"));
  scheduler.runNextTimeout();
  await drainMicrotasks();
  mqttClient.emit("message", "topic", amsPayload("X"));

  writeY.resolve();
  await drainMicrotasks();
  scheduler.runNextTimeout();
  await drainMicrotasks();
  assert.deepEqual(calls, ["X", "Y", "X"]);
  bambu.stop();
});

test("printer status retries are latest-wins per task without dropping another task", async () => {
  const calls = [];
  let failedTaskA = false;
  const { bambu, mqttClient, scheduler } = harness({
    onPrinterStatus: (status) => {
      calls.push(`${status.task_id}:${status.mc_percent}`);
      if (status.task_id === "A" && !failedTaskA) {
        failedTaskA = true;
        return Promise.reject(new Error("offline"));
      }
      return undefined;
    }
  });

  mqttClient.emit("message", "topic", printPayload("A", 99, "FINISH"));
  mqttClient.emit("message", "topic", printPayload("B", 1));
  await drainMicrotasks();
  assert.deepEqual(calls, ["A:99", "B:1"]);
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 10);

  scheduler.runNextTimeout();
  await drainMicrotasks();
  assert.deepEqual(calls, ["A:99", "B:1", "A:99"]);
  assert.equal(bambu.status().retryingPrinterStatus, false);
  bambu.stop();
});

test("subscription failures back off, recover readiness, and stop cancels stale timers", async () => {
  let readyCalls = 0;
  const subscribeImpl = (_topic, callback, call) => {
    if (call === 1) throw new Error("subscribe threw");
    if (call === 2) callback(new Error("subscribe failed"));
    else callback(null);
  };
  const { bambu, mqttClient, scheduler } = harness({
    subscribeImpl,
    onReady: () => {
      readyCalls += 1;
      return undefined;
    },
    configOverrides: { pushAllOnStart: true, pushAllIntervalMs: 1000 }
  });

  assert.equal(bambu.status().connected, true);
  assert.equal(bambu.status().subscribed, false);
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 10);
  scheduler.runNextTimeout();
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 20);
  scheduler.runNextTimeout();
  await drainMicrotasks();

  assert.equal(mqttClient.subscribeCalls, 3);
  assert.equal(bambu.status().subscribed, true);
  assert.equal(readyCalls, 1);
  assert.equal(mqttClient.publishCalls.length, 1);

  mqttClient.emit("close");
  const staleTimers = scheduler.records.filter((record) => !record.fired);
  bambu.stop();
  for (const record of staleTimers) scheduler.run(record, { force: true });
  await drainMicrotasks();
  assert.equal(bambu.status().connected, false);
  assert.equal(bambu.status().subscribed, false);
  assert.equal(mqttClient.endCalls, 1);
  assert.equal(mqttClient.subscribeCalls, 3);
});

test("a hanging subscription times out, retries, and ignores its late callback", async () => {
  let firstCallback;
  let readyCalls = 0;
  const { bambu, mqttClient, scheduler } = harness({
    subscribeImpl: (_topic, callback, call) => {
      if (call === 1) firstCallback = callback;
      else callback(null);
    },
    onReady: () => {
      readyCalls += 1;
    },
    runtimeOverrides: { subscribeTimeoutMs: 15 }
  });

  assert.equal(bambu.status().subscribed, false);
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 15);
  scheduler.runNextTimeout();
  assert.equal(scheduler.pendingTimeouts()[0]?.delay, 10);
  scheduler.runNextTimeout();
  await drainMicrotasks();

  assert.equal(mqttClient.subscribeCalls, 2);
  assert.equal(bambu.status().subscribed, true);
  assert.equal(readyCalls, 1);
  firstCallback(null);
  await drainMicrotasks();
  assert.equal(readyCalls, 1);
  bambu.stop();
});

test("stop cancels AMS and printer retry timers and stale callbacks stay inert", async () => {
  let trayCalls = 0;
  let printerCalls = 0;
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: () => {
      trayCalls += 1;
      return Promise.reject(new Error("tray offline"));
    },
    onPrinterStatus: () => {
      printerCalls += 1;
      return Promise.reject(new Error("printer offline"));
    },
    configOverrides: { pushAllIntervalMs: 1000 }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  scheduler.runNextTimeout();
  mqttClient.emit("message", "topic", printPayload("A", 10));
  await drainMicrotasks();
  assert.equal(bambu.status().retryingTrays, true);
  assert.equal(bambu.status().retryingPrinterStatus, true);

  const trayCallsBeforeStop = trayCalls;
  const printerCallsBeforeStop = printerCalls;
  const staleRecords = scheduler.records.filter((record) => !record.fired);
  bambu.stop();
  for (const record of staleRecords) scheduler.run(record, { force: true });
  await drainMicrotasks();

  assert.equal(trayCalls, trayCallsBeforeStop);
  assert.equal(printerCalls, printerCallsBeforeStop);
  assert.equal(bambu.status().retryingTrays, false);
  assert.equal(bambu.status().retryingPrinterStatus, false);
  assert.equal(mqttClient.endCalls, 1);
});

test("stop prevents callbacks already queued in microtasks from starting", async () => {
  let readyCalls = 0;
  let trayCalls = 0;
  let printerCalls = 0;
  const { bambu, mqttClient, scheduler } = harness({
    onReady: () => {
      readyCalls += 1;
    },
    onTrays: () => {
      trayCalls += 1;
    },
    onPrinterStatus: () => {
      printerCalls += 1;
    }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  scheduler.runNextTimeout();
  mqttClient.emit("message", "topic", printPayload("A", 10));
  bambu.stop();
  await drainMicrotasks();

  assert.equal(readyCalls, 0);
  assert.equal(trayCalls, 0);
  assert.equal(printerCalls, 0);
});

test("AMS debounce restarts from the latest changed snapshot", async () => {
  const calls = [];
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: (trays) => {
      calls.push(trays[0].uid);
    },
    configOverrides: { syncDebounceMs: 100 }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  const firstTimer = scheduler.pendingTimeouts()[0];
  mqttClient.emit("message", "topic", amsPayload("B"));
  const secondTimer = scheduler.pendingTimeouts()[0];

  assert.notEqual(secondTimer, firstTimer);
  assert.equal(firstTimer.cancelled, true);
  scheduler.run(firstTimer, { force: true });
  await drainMicrotasks();
  assert.deepEqual(calls, []);
  scheduler.run(secondTimer);
  await drainMicrotasks();
  assert.deepEqual(calls, ["B"]);
  bambu.stop();
});

test("stop aborts the signal passed to an in-flight sync callback", async () => {
  const entered = deferred();
  let callbackSignal;
  const { bambu, mqttClient, scheduler } = harness({
    onTrays: (_trays, { signal }) => {
      callbackSignal = signal;
      entered.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  });

  mqttClient.emit("message", "topic", amsPayload("A"));
  scheduler.runNextTimeout();
  await entered.promise;
  bambu.stop();
  await drainMicrotasks();

  assert.equal(callbackSignal.aborted, true);
  assert.equal(bambu.status().retryingTrays, false);
});
