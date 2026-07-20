import mqtt from "mqtt";

const RUNTIME_RETRY_BASE_MS = 5_000;
const RUNTIME_RETRY_MAX_MS = 5 * 60 * 1000;
const MQTT_SUBSCRIBE_TIMEOUT_MS = 30_000;

function formatError(error) {
  try {
    if (error == null) return String(error);
    if (typeof error.stack === "string" && error.stack) return error.stack;
    if (typeof error.message === "string" && error.message) return error.message;
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function safeLog(logger, level, ...args) {
  try {
    logger?.[level]?.(...args);
  } catch {
    // Logging must never turn a recoverable runtime failure into a process failure.
  }
}

function retryDelay(attempt, { retryBaseMs: baseMs, retryMaxMs: maxMs, random }) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(Math.min(maxMs, exponential * jitter)));
}

function isZeroish(value) {
  return value == null || value === "" || /^0+$/.test(String(value));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergePlainObjects(target, source) {
  if (!isPlainObject(source)) return target;

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      target[key] = mergePlainObjects({ ...target[key] }, value);
    } else {
      target[key] = value;
    }
  }

  return target;
}

function normalizeHexColor(value) {
  if (!value || typeof value !== "string") return "";
  const hex = value.replace(/^#/, "").slice(0, 6).toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : "";
}

function normalizeHexColors(values, fallback = "") {
  const source = Array.isArray(values) ? values : [values];
  const colors = [];
  for (const value of source) {
    const color = normalizeHexColor(value);
    if (color && !colors.includes(color)) colors.push(color);
  }

  const fallbackColor = normalizeHexColor(fallback);
  if (colors.length === 0 && fallbackColor) colors.push(fallbackColor);
  return colors;
}

function trayColorType(slot, colors) {
  if (colors.length < 2) return "single";
  const raw = Number.parseInt(slot.ctype, 10);
  if (raw === 1) return "multi";
  return "gradient";
}

function correctRemainPercent(remain, trayWeight, correctForTrayWeight) {
  if (remain == null) return null;
  if (!correctForTrayWeight || trayWeight == null || trayWeight >= 1000) return Math.round(remain);

  const gramsOnOneKgBasis = (remain / 100) * 1000;
  const corrected = (gramsOnOneKgBasis / trayWeight) * 100;
  return Math.max(0, Math.min(100, Math.round(corrected)));
}

function slotLabel(amsId, slotId) {
  const amsIndex = Number.parseInt(amsId, 10);
  const slotIndex = Number.parseInt(slotId, 10);
  const prefix = Number.isFinite(amsIndex) ? String.fromCharCode(65 + amsIndex) : String(amsId);
  return `${prefix}${Number.isFinite(slotIndex) ? slotIndex : slotId}`;
}

function pickUid(slot, uidFields) {
  for (const field of Array.isArray(uidFields) ? uidFields : []) {
    const value = slot[field];
    if (!isZeroish(value)) return String(value);
  }
  return "";
}

function validAmsList(value) {
  return Array.isArray(value) && value.every((ams) => (
    isPlainObject(ams) &&
    (ams.tray == null || (Array.isArray(ams.tray) && ams.tray.every((slot) => isPlainObject(slot))))
  ));
}

function traySnapshotSignature(trays) {
  return JSON.stringify(
    trays
      .map((tray) => ({
        uid: tray.uid,
        tagUid: tray.tagUid,
        trayUuid: tray.trayUuid,
        slotLabel: tray.slotLabel,
        material: tray.material,
        trayType: tray.trayType,
        color: tray.color,
        colors: tray.colors || [],
        colorType: tray.colorType || "",
        remainPercent: tray.remainPercent,
        remainGrams: tray.remainGrams,
        trayWeight: tray.trayWeight
      }))
      .sort((a, b) => `${a.uid}:${a.slotLabel}`.localeCompare(`${b.uid}:${b.slotLabel}`))
  );
}

function printerStatusKey(printState) {
  const taskId = isZeroish(printState?.task_id) ? "" : String(printState.task_id);
  const subtaskId = isZeroish(printState?.subtask_id) ? "" : String(printState.subtask_id);
  if (taskId) return `task:${taskId}`;
  if (subtaskId) return `subtask:${subtaskId}`;

  const projectId = isZeroish(printState?.project_id) ? "" : String(printState.project_id);
  const profileId = isZeroish(printState?.profile_id) ? "" : String(printState.profile_id);
  if (projectId && profileId) return `project:${projectId}:profile:${profileId}`;

  const gcodeFile = String(printState?.gcode_file || "");
  const gcodeStartTime = isZeroish(printState?.gcode_start_time) ? "" : String(printState.gcode_start_time);
  if (gcodeFile && gcodeStartTime) return `gcode:${gcodeFile}:${gcodeStartTime}`;
  return "printer-status";
}

export function extractAmsTrays(message, config) {
  const amsList = message?.print?.ams?.ams;
  if (!Array.isArray(amsList)) return [];

  const trays = [];
  for (const ams of amsList) {
    if (!isPlainObject(ams)) continue;
    if (!Array.isArray(ams.tray)) continue;

    for (const slot of ams.tray) {
      if (!isPlainObject(slot) || Object.keys(slot).length <= 1) continue;

      const uid = pickUid(slot, config?.uidFields);
      if (!uid) continue;

      const rawRemain = toNumber(slot.remain);
      const trayWeight = toNumber(slot.tray_weight) || config?.defaultSpoolWeightGrams || null;
      const remainPercent = correctRemainPercent(
        rawRemain,
        trayWeight,
        config?.correctRemainForTrayWeight
      );
      const remainGrams =
        remainPercent != null && trayWeight != null
          ? Math.round((remainPercent / 100) * trayWeight)
          : null;
      const colors = normalizeHexColors(slot.cols, slot.tray_color);
      const colorType = trayColorType(slot, colors);

      trays.push({
        uid,
        tagUid: isZeroish(slot.tag_uid) ? "" : String(slot.tag_uid),
        trayUuid: isZeroish(slot.tray_uuid) ? "" : String(slot.tray_uuid),
        amsId: String(ams.id ?? ""),
        slotId: String(slot.id ?? ""),
        slotLabel: slotLabel(ams.id, slot.id),
        material: slot.tray_sub_brands || slot.tray_type || "",
        trayType: slot.tray_type || "",
        color: colors[0] || "",
        colors,
        colorType,
        remainPercent,
        remainGrams,
        trayWeight,
        raw: slot
      });
    }
  }

  return trays;
}

export class BambuMqttClient {
  constructor(config, logger, onTrays, onPrinterStatus = null, onReady = null, runtime = {}) {
    this.config = config;
    this.logger = logger;
    this.onTrays = onTrays;
    this.onPrinterStatus = onPrinterStatus;
    this.onReady = onReady;
    this.mqttConnect = runtime.mqttConnect || mqtt.connect;
    this.setRuntimeTimeout = runtime.setTimeout || setTimeout;
    this.clearRuntimeTimeout = runtime.clearTimeout || clearTimeout;
    this.setRuntimeInterval = runtime.setInterval || setInterval;
    this.clearRuntimeInterval = runtime.clearInterval || clearInterval;
    this.retryBaseMs = Math.max(1, Number(runtime.retryBaseMs) || RUNTIME_RETRY_BASE_MS);
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(runtime.retryMaxMs) || RUNTIME_RETRY_MAX_MS);
    this.subscribeTimeoutMs = Math.max(1, Number(runtime.subscribeTimeoutMs) || MQTT_SUBSCRIBE_TIMEOUT_MS);
    this.random = typeof runtime.random === "function" ? runtime.random : Math.random;
    this.client = null;
    this.pushAllTimer = null;
    this.debounceTimer = null;
    this.trayRetryTimer = null;
    this.subscribeRetryTimer = null;
    this.subscribeDeadlineTimer = null;
    this.lastTrays = [];
    this.lastTraySnapshotSignature = "";
    this.pendingTraySnapshotSignature = "";
    this.pendingTraySnapshot = null;
    this.activeTraySnapshotSignature = "";
    this.traySyncInFlight = false;
    this.trayRetryAttempt = 0;
    this.forceNextTrayFlush = false;
    this.lastPrintState = {};
    this.printerStatusEntries = new Map();
    this.sequence = 0;
    this.connected = false;
    this.subscribed = false;
    this.subscribeRetryAttempt = 0;
    this.subscribeRequestId = 0;
    this.connectionEpoch = 0;
    this.lifecycleId = 0;
    this.lifecycleController = null;
    this.stopped = true;
    this.reportTopic = "";
  }

  start() {
    if (this.client) this.stop();
    const connection = this.connectionSettings();
    const url = `tls://${connection.host}:8883`;
    const reportTopic = `device/${this.config.printerSerial}/report`;
    const lifecycleId = ++this.lifecycleId;
    const lifecycleController = new AbortController();
    this.lifecycleController = lifecycleController;
    this.stopped = false;
    this.connected = false;
    this.subscribed = false;
    this.reportTopic = reportTopic;

    let client;
    try {
      client = this.mqttConnect(url, {
        username: connection.username,
        password: connection.password,
        rejectUnauthorized: this.config.rejectUnauthorized,
        clientId: `bambu-ams-notion-sync-${this.config.printerSerial}-${Date.now()}`,
        reconnectPeriod: 1000,
        resubscribe: true
      });
      this.client = client;
    } catch (error) {
      lifecycleController.abort(error);
      if (this.lifecycleController === lifecycleController) this.lifecycleController = null;
      this.stopped = true;
      throw error;
    }

    client.on("connect", () => {
      if (!this.isCurrentClient(client, lifecycleId)) return;
      try {
        this.handleConnect(client, lifecycleId, url);
      } catch (error) {
        safeLog(this.logger, "error", "MQTT connect handler failed:", formatError(error));
      }
    });
    client.on("message", (_topic, payload) => {
      if (!this.isCurrentClient(client, lifecycleId)) return;
      try {
        this.handleMessage(payload);
      } catch (error) {
        safeLog(this.logger, "error", "MQTT message handler failed:", formatError(error));
      }
    });
    client.on("error", (error) => {
      if (!this.isCurrentClient(client, lifecycleId)) return;
      safeLog(this.logger, "error", "MQTT error:", formatError(error));
    });
    client.on("close", () => {
      if (!this.isCurrentClient(client, lifecycleId)) return;
      this.connected = false;
      this.subscribed = false;
      this.connectionEpoch += 1;
      this.subscribeRequestId += 1;
      this.clearSubscribeDeadline();
      this.clearSubscribeRetry();
      safeLog(this.logger, "warn", "MQTT connection closed");
    });
    client.on("reconnect", () => {
      if (!this.isCurrentClient(client, lifecycleId)) return;
      safeLog(this.logger, "info", "Reconnecting to Bambu MQTT...");
    });
  }

  isCurrentClient(client, lifecycleId) {
    return !this.stopped && this.client === client && this.lifecycleId === lifecycleId;
  }

  handleConnect(client, lifecycleId, url) {
    if (!this.isCurrentClient(client, lifecycleId)) return;
    this.connected = true;
    this.subscribed = false;
    this.connectionEpoch += 1;
    const connectionEpoch = this.connectionEpoch;
    this.subscribeRequestId += 1;
    this.clearSubscribeDeadline();
    this.clearSubscribeRetry({ resetAttempt: true });
    safeLog(this.logger, "info", `Connected to Bambu MQTT at ${url}`);

    this.clearRuntimeInterval(this.pushAllTimer);
    this.pushAllTimer = null;
    if (this.config.pushAllIntervalMs > 0) {
      let timer = null;
      timer = this.setRuntimeInterval(() => {
        if (this.pushAllTimer !== timer || !this.isCurrentClient(client, lifecycleId)) return;
        this.requestPushAll();
      }, this.config.pushAllIntervalMs);
      this.pushAllTimer = timer;
    }

    this.subscribeToReport(client, lifecycleId, connectionEpoch);
  }

  subscribeToReport(client, lifecycleId, connectionEpoch) {
    if (
      !this.isCurrentClient(client, lifecycleId) ||
      !this.connected ||
      connectionEpoch !== this.connectionEpoch
    ) {
      return;
    }

    const requestId = ++this.subscribeRequestId;
    let settled = false;
    let deadlineTimer = null;
    const onSubscribed = (error) => {
      if (settled) return;
      settled = true;
      if (this.subscribeDeadlineTimer === deadlineTimer) {
        this.clearRuntimeTimeout(deadlineTimer);
        this.subscribeDeadlineTimer = null;
      }
      if (
        !this.isCurrentClient(client, lifecycleId) ||
        connectionEpoch !== this.connectionEpoch ||
        requestId !== this.subscribeRequestId
      ) {
        return;
      }

      if (error) {
        this.subscribed = false;
        safeLog(this.logger, "error", "Failed to subscribe to report topic:", formatError(error));
        this.scheduleSubscribeRetry(client, lifecycleId, connectionEpoch);
        return;
      }

      this.subscribed = true;
      this.clearSubscribeRetry({ resetAttempt: true });
      safeLog(this.logger, "info", `Subscribed to ${this.reportTopic}`);
      if (this.config.pushAllOnStart) this.requestPushAll();
      this.invokeReady(lifecycleId, connectionEpoch);
    };

    deadlineTimer = this.setRuntimeTimeout(() => {
      if (this.subscribeDeadlineTimer !== deadlineTimer) return;
      this.subscribeDeadlineTimer = null;
      onSubscribed(new Error(`Bambu MQTT subscription timed out after ${this.subscribeTimeoutMs}ms`));
    }, this.subscribeTimeoutMs);
    this.subscribeDeadlineTimer = deadlineTimer;

    try {
      client.subscribe(this.reportTopic, onSubscribed);
    } catch (error) {
      onSubscribed(error);
    }
  }

  scheduleSubscribeRetry(client, lifecycleId, connectionEpoch) {
    if (this.subscribeRetryTimer != null || !this.isCurrentClient(client, lifecycleId) || !this.connected) return;
    const attempt = ++this.subscribeRetryAttempt;
    const delay = retryDelay(attempt, this);
    let timer = null;
    timer = this.setRuntimeTimeout(() => {
      if (this.subscribeRetryTimer !== timer) return;
      this.subscribeRetryTimer = null;
      if (!this.isCurrentClient(client, lifecycleId) || connectionEpoch !== this.connectionEpoch) return;
      this.subscribeToReport(client, lifecycleId, connectionEpoch);
    }, delay);
    this.subscribeRetryTimer = timer;
    safeLog(this.logger, "warn", `Retrying Bambu MQTT subscription in ${delay}ms (attempt ${attempt})`);
  }

  clearSubscribeRetry({ resetAttempt = false } = {}) {
    if (this.subscribeRetryTimer != null) this.clearRuntimeTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
    if (resetAttempt) this.subscribeRetryAttempt = 0;
  }

  clearSubscribeDeadline() {
    if (this.subscribeDeadlineTimer != null) this.clearRuntimeTimeout(this.subscribeDeadlineTimer);
    this.subscribeDeadlineTimer = null;
  }

  invokeReady(lifecycleId, connectionEpoch) {
    if (!this.onReady) return;
    void Promise.resolve()
      .then(() => {
        if (this.lifecycleId !== lifecycleId || this.connectionEpoch !== connectionEpoch || this.stopped) return;
        return this.onReady();
      })
      .catch((error) => {
        if (this.lifecycleId !== lifecycleId || this.connectionEpoch !== connectionEpoch || this.stopped) return;
        safeLog(this.logger, "error", "MQTT ready callback failed:", formatError(error));
      });
  }

  connectionSettings() {
    if (this.config.connectionMode === "cloud") {
      const cloud = this.config.cloud;
      if (!cloud?.broker || !cloud?.uid || !cloud?.accessToken) {
        throw new Error("Cloud mode requires a saved Bambu cloud token. Run npm run cloud:login first.");
      }
      return {
        host: cloud.broker,
        username: cloud.uid.startsWith("u_") ? cloud.uid : `u_${cloud.uid}`,
        password: cloud.accessToken
      };
    }

    return {
      host: this.config.printerIp,
      username: "bblp",
      password: this.config.accessCode
    };
  }

  requestPushAll(reason = "scheduled") {
    if (this.stopped || !this.connected || !this.subscribed || !this.client?.connected) return false;
    const requestTopic = `device/${this.config.printerSerial}/request`;
    const sequenceId = String(++this.sequence);
    const payload = {
      pushing: {
        sequence_id: sequenceId,
        command: "pushall",
        version: 1,
        push_target: 1
      }
    };

    safeLog(this.logger, "info", `Requesting full printer status via pushall (${reason})`);
    const client = this.client;
    const lifecycleId = this.lifecycleId;
    try {
      client.publish(requestTopic, JSON.stringify(payload), (error) => {
        if (!error || !this.isCurrentClient(client, lifecycleId)) return;
        safeLog(this.logger, "error", "Bambu pushall request failed:", formatError(error));
      });
      return true;
    } catch (error) {
      safeLog(this.logger, "error", "Failed to publish Bambu pushall request:", formatError(error));
      return false;
    }
  }

  requestManualSync() {
    this.forceNextTrayFlush = true;
    const requested = this.requestPushAll("manual");
    if (!requested) this.forceNextTrayFlush = false;
    return requested;
  }

  handleMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload.toString());
    } catch {
      safeLog(this.logger, "warn", "Skipping non-JSON MQTT payload");
      return;
    }

    if (!isPlainObject(message)) {
      safeLog(this.logger, "warn", "Skipping MQTT payload whose root is not an object");
      return;
    }

    if (message.print != null && !isPlainObject(message.print)) {
      safeLog(this.logger, "warn", "Skipping MQTT payload with malformed print state");
      return;
    }

    let hasValidAmsPayload = false;
    if (isPlainObject(message.print)) {
      let printUpdate = message.print;
      if (message.print.ams != null && !isPlainObject(message.print.ams)) {
        const { ams: _malformedAms, ...rest } = message.print;
        printUpdate = rest;
        safeLog(this.logger, "warn", "Ignoring malformed MQTT AMS state");
      } else if (isPlainObject(message.print.ams) && Object.hasOwn(message.print.ams, "ams")) {
        const rawAmsList = message.print.ams.ams;
        if (validAmsList(rawAmsList)) {
          hasValidAmsPayload = true;
        } else {
          const { ams: _malformedAmsList, ...amsRest } = message.print.ams;
          printUpdate = { ...message.print, ams: amsRest };
          safeLog(this.logger, "warn", "Ignoring malformed entries in MQTT AMS payload");
        }
      }

      try {
        this.lastPrintState = mergePlainObjects({ ...this.lastPrintState }, printUpdate);
      } catch (error) {
        safeLog(this.logger, "warn", "Skipping malformed MQTT print state:", formatError(error));
        return;
      }
      if (this.onPrinterStatus) {
        this.queuePrinterStatus(this.lastPrintState);
      }
    }

    if (!hasValidAmsPayload) return;

    let trays;
    try {
      trays = extractAmsTrays({ print: this.lastPrintState }, this.config);
    } catch (error) {
      safeLog(this.logger, "warn", "Skipping malformed MQTT AMS payload:", formatError(error));
      return;
    }
    if (trays.length === 0) return;

    let signature;
    try {
      signature = traySnapshotSignature(trays);
    } catch (error) {
      safeLog(this.logger, "warn", "Skipping invalid AMS snapshot:", formatError(error));
      return;
    }

    this.queueTraySnapshot(trays, signature);
  }

  queueTraySnapshot(trays, signature) {
    const force = this.forceNextTrayFlush;
    this.lastTrays = trays;

    if (!force && this.pendingTraySnapshotSignature === signature) {
      safeLog(this.logger, "debug", "Skipping unchanged pending AMS snapshot");
      return;
    }

    if (!force && !this.traySyncInFlight && signature === this.lastTraySnapshotSignature) {
      this.forceNextTrayFlush = false;
      this.pendingTraySnapshot = null;
      this.pendingTraySnapshotSignature = "";
      this.clearTrayDebounce();
      this.clearTrayRetry({ resetAttempt: true });
      safeLog(this.logger, "debug", "Skipping unchanged AMS snapshot");
      return;
    }

    if (
      !force &&
      this.traySyncInFlight &&
      !this.pendingTraySnapshot &&
      signature === this.activeTraySnapshotSignature
    ) {
      safeLog(this.logger, "debug", "Skipping AMS snapshot already being synced");
      return;
    }

    this.forceNextTrayFlush = false;
    this.pendingTraySnapshot = { trays, signature, force };
    this.pendingTraySnapshotSignature = signature;
    if (this.traySyncInFlight || this.trayRetryTimer != null) return;
    this.clearTrayDebounce();
    this.scheduleTrayDebounce();
  }

  scheduleTrayDebounce() {
    if (this.stopped || this.debounceTimer != null || !this.pendingTraySnapshot) return;
    const lifecycleId = this.lifecycleId;
    let timer = null;
    timer = this.setRuntimeTimeout(() => {
      if (this.debounceTimer !== timer) return;
      this.debounceTimer = null;
      if (this.stopped || this.lifecycleId !== lifecycleId) return;
      this.flushTrays();
    }, Math.max(0, Number(this.config.syncDebounceMs) || 0));
    this.debounceTimer = timer;
  }

  clearTrayDebounce() {
    if (this.debounceTimer != null) this.clearRuntimeTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  flushTrays() {
    if (this.stopped || this.traySyncInFlight || this.trayRetryTimer != null || !this.pendingTraySnapshot) return;
    const snapshot = this.pendingTraySnapshot;
    const lifecycleId = this.lifecycleId;
    const signal = this.lifecycleController?.signal;
    this.pendingTraySnapshot = null;
    this.pendingTraySnapshotSignature = "";
    this.traySyncInFlight = true;
    this.activeTraySnapshotSignature = snapshot.signature;
    safeLog(this.logger, "info", `AMS snapshot: ${snapshot.trays.length} loaded tagged tray(s)`);
    void Promise.resolve()
      .then(() => {
        if (this.stopped || this.lifecycleId !== lifecycleId) return;
        return this.onTrays(snapshot.trays, { signal });
      })
      .then(() => {
        if (this.stopped || this.lifecycleId !== lifecycleId) return;
        this.traySyncInFlight = false;
        this.activeTraySnapshotSignature = "";
        this.lastTraySnapshotSignature = snapshot.signature;
        this.clearTrayRetry({ resetAttempt: true });

        if (
          this.pendingTraySnapshot &&
          !this.pendingTraySnapshot.force &&
          this.pendingTraySnapshot.signature === this.lastTraySnapshotSignature
        ) {
          this.pendingTraySnapshot = null;
          this.pendingTraySnapshotSignature = "";
        }
        if (this.pendingTraySnapshot) this.scheduleTrayDebounce();
      })
      .catch((error) => {
        if (this.stopped || this.lifecycleId !== lifecycleId) return;
        this.traySyncInFlight = false;
        this.activeTraySnapshotSignature = "";
        if (!this.pendingTraySnapshot) {
          this.pendingTraySnapshot = snapshot;
          this.pendingTraySnapshotSignature = snapshot.signature;
        }
        safeLog(this.logger, "error", "Sync failed:", formatError(error));
        this.scheduleTrayRetry(lifecycleId);
      });
  }

  scheduleTrayRetry(lifecycleId = this.lifecycleId) {
    if (this.stopped || this.trayRetryTimer != null || !this.pendingTraySnapshot) return;
    this.clearTrayDebounce();
    const attempt = ++this.trayRetryAttempt;
    const delay = retryDelay(attempt, this);
    let timer = null;
    timer = this.setRuntimeTimeout(() => {
      if (this.trayRetryTimer !== timer) return;
      this.trayRetryTimer = null;
      if (this.stopped || this.lifecycleId !== lifecycleId) return;
      this.flushTrays();
    }, delay);
    this.trayRetryTimer = timer;
    safeLog(this.logger, "warn", `Retrying AMS sync in ${delay}ms (attempt ${attempt})`);
  }

  clearTrayRetry({ resetAttempt = false } = {}) {
    if (this.trayRetryTimer != null) this.clearRuntimeTimeout(this.trayRetryTimer);
    this.trayRetryTimer = null;
    if (resetAttempt) this.trayRetryAttempt = 0;
  }

  queuePrinterStatus(printState) {
    const key = printerStatusKey(printState);
    let entry = this.printerStatusEntries.get(key);
    if (!entry) {
      entry = {
        latest: printState,
        version: 0,
        inFlight: false,
        retryTimer: null,
        retryAttempt: 0
      };
      this.printerStatusEntries.set(key, entry);
    }
    entry.latest = printState;
    entry.version += 1;
    if (!entry.inFlight && entry.retryTimer == null) this.flushPrinterStatus(key, entry);
  }

  flushPrinterStatus(key, entry = this.printerStatusEntries.get(key)) {
    if (
      this.stopped ||
      !this.onPrinterStatus ||
      !entry ||
      this.printerStatusEntries.get(key) !== entry ||
      entry.inFlight ||
      entry.retryTimer != null
    ) {
      return;
    }

    const lifecycleId = this.lifecycleId;
    const signal = this.lifecycleController?.signal;
    const printState = entry.latest;
    const version = entry.version;
    entry.inFlight = true;
    void Promise.resolve()
      .then(() => {
        if (
          this.stopped ||
          this.lifecycleId !== lifecycleId ||
          this.printerStatusEntries.get(key) !== entry
        ) {
          return;
        }
        return this.onPrinterStatus(printState, { signal });
      })
      .then(() => {
        if (
          this.stopped ||
          this.lifecycleId !== lifecycleId ||
          this.printerStatusEntries.get(key) !== entry
        ) {
          return;
        }
        entry.inFlight = false;
        entry.retryAttempt = 0;
        if (entry.version === version) {
          this.printerStatusEntries.delete(key);
        } else {
          this.flushPrinterStatus(key, entry);
        }
      })
      .catch((error) => {
        if (
          this.stopped ||
          this.lifecycleId !== lifecycleId ||
          this.printerStatusEntries.get(key) !== entry
        ) {
          return;
        }
        entry.inFlight = false;
        safeLog(this.logger, "error", "Print task sync failed:", formatError(error));
        this.schedulePrinterStatusRetry(key, entry, lifecycleId);
      });
  }

  schedulePrinterStatusRetry(key, entry, lifecycleId = this.lifecycleId) {
    if (this.stopped || entry.retryTimer != null || this.printerStatusEntries.get(key) !== entry) return;
    const attempt = ++entry.retryAttempt;
    const delay = retryDelay(attempt, this);
    let timer = null;
    timer = this.setRuntimeTimeout(() => {
      if (entry.retryTimer !== timer) return;
      entry.retryTimer = null;
      if (this.stopped || this.lifecycleId !== lifecycleId || this.printerStatusEntries.get(key) !== entry) return;
      this.flushPrinterStatus(key, entry);
    }, delay);
    entry.retryTimer = timer;
    safeLog(this.logger, "warn", `Retrying print task sync in ${delay}ms (attempt ${attempt})`);
  }

  stop() {
    const client = this.client;
    const lifecycleController = this.lifecycleController;
    this.lifecycleController = null;
    if (lifecycleController && !lifecycleController.signal.aborted) {
      lifecycleController.abort(new Error("Bambu MQTT runtime stopped"));
    }
    this.stopped = true;
    this.lifecycleId += 1;
    this.connectionEpoch += 1;
    this.subscribeRequestId += 1;
    this.clearRuntimeInterval(this.pushAllTimer);
    this.pushAllTimer = null;
    this.clearTrayDebounce();
    this.clearTrayRetry({ resetAttempt: true });
    this.clearSubscribeDeadline();
    this.clearSubscribeRetry({ resetAttempt: true });
    for (const entry of this.printerStatusEntries.values()) {
      if (entry.retryTimer != null) this.clearRuntimeTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    this.printerStatusEntries.clear();
    this.pendingTraySnapshot = null;
    this.pendingTraySnapshotSignature = "";
    this.activeTraySnapshotSignature = "";
    this.traySyncInFlight = false;
    this.forceNextTrayFlush = false;
    this.connected = false;
    this.subscribed = false;
    this.client = null;
    try {
      client?.end(true);
    } catch (error) {
      safeLog(this.logger, "error", "Failed to stop Bambu MQTT client:", formatError(error));
    }
  }

  status() {
    return {
      connected: this.connected,
      subscribed: this.subscribed,
      printerSerial: this.config.printerSerial,
      connectionMode: this.config.connectionMode,
      lastTrayCount: this.lastTrays.length,
      retryingSubscription: this.subscribeRetryTimer != null,
      retryingTrays: this.trayRetryTimer != null,
      retryingPrinterStatus: [...this.printerStatusEntries.values()].some((entry) => entry.retryTimer != null)
    };
  }
}
