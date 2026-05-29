import mqtt from "mqtt";

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
  for (const field of uidFields) {
    const value = slot[field];
    if (!isZeroish(value)) return String(value);
  }
  return "";
}

function hasAmsTrayPayload(message) {
  return Array.isArray(message?.print?.ams?.ams);
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

export function extractAmsTrays(message, config) {
  const amsList = message?.print?.ams?.ams;
  if (!Array.isArray(amsList)) return [];

  const trays = [];
  for (const ams of amsList) {
    if (!Array.isArray(ams.tray)) continue;

    for (const slot of ams.tray) {
      if (!slot || Object.keys(slot).length <= 1) continue;

      const uid = pickUid(slot, config.uidFields);
      if (!uid) continue;

      const rawRemain = toNumber(slot.remain);
      const trayWeight = toNumber(slot.tray_weight) || config.defaultSpoolWeightGrams || null;
      const remainPercent = correctRemainPercent(
        rawRemain,
        trayWeight,
        config.correctRemainForTrayWeight
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
  constructor(config, logger, onTrays, onPrinterStatus = null, onReady = null) {
    this.config = config;
    this.logger = logger;
    this.onTrays = onTrays;
    this.onPrinterStatus = onPrinterStatus;
    this.onReady = onReady;
    this.client = null;
    this.pushAllTimer = null;
    this.debounceTimer = null;
    this.lastTrays = [];
    this.lastTraySnapshotSignature = "";
    this.pendingTraySnapshotSignature = "";
    this.forceNextTrayFlush = false;
    this.lastPrintState = {};
    this.sequence = 0;
    this.connected = false;
  }

  start() {
    const connection = this.connectionSettings();
    const url = `tls://${connection.host}:8883`;
    const reportTopic = `device/${this.config.printerSerial}/report`;

    this.client = mqtt.connect(url, {
      username: connection.username,
      password: connection.password,
      rejectUnauthorized: this.config.rejectUnauthorized,
      clientId: `bambu-ams-notion-sync-${this.config.printerSerial}-${Date.now()}`
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.logger.info(`Connected to Bambu MQTT at ${url}`);
      this.client.subscribe(reportTopic, (error) => {
        if (error) {
          this.logger.error("Failed to subscribe to report topic:", error.message);
          return;
        }

        this.logger.info(`Subscribed to ${reportTopic}`);
        if (this.config.pushAllOnStart) this.requestPushAll();
        if (this.onReady) {
          Promise.resolve(this.onReady()).catch((readyError) => {
            this.logger.error("MQTT ready callback failed:", readyError.stack || readyError.message);
          });
        }
      });

      if (this.config.pushAllIntervalMs > 0) {
        clearInterval(this.pushAllTimer);
        this.pushAllTimer = setInterval(() => this.requestPushAll(), this.config.pushAllIntervalMs);
      }
    });

    this.client.on("message", (_topic, payload) => this.handleMessage(payload));
    this.client.on("error", (error) => this.logger.error("MQTT error:", error.message));
    this.client.on("close", () => {
      this.connected = false;
      this.logger.warn("MQTT connection closed");
    });
    this.client.on("reconnect", () => this.logger.info("Reconnecting to Bambu MQTT..."));
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
    if (!this.client?.connected) return false;
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

    this.logger.info(`Requesting full printer status via pushall (${reason})`);
    this.client.publish(requestTopic, JSON.stringify(payload));
    return true;
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
    } catch (error) {
      this.logger.warn("Skipping non-JSON MQTT payload");
      return;
    }

    if (message.print) {
      this.lastPrintState = mergePlainObjects({ ...this.lastPrintState }, message.print);
      if (this.onPrinterStatus) {
        this.onPrinterStatus(this.lastPrintState).catch((error) => {
          this.logger.error("Print task sync failed:", error.stack || error.message);
        });
      }
    }

    if (!hasAmsTrayPayload(message)) return;

    const trays = extractAmsTrays({ print: this.lastPrintState }, this.config);
    if (trays.length === 0) return;

    const signature = traySnapshotSignature(trays);
    if (
      !this.forceNextTrayFlush &&
      (signature === this.lastTraySnapshotSignature || signature === this.pendingTraySnapshotSignature)
    ) {
      this.logger.debug("Skipping unchanged AMS snapshot");
      return;
    }

    this.lastTrays = trays;
    this.pendingTraySnapshotSignature = signature;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushTrays(), this.config.syncDebounceMs);
  }

  flushTrays() {
    const trays = this.lastTrays;
    const signature = this.pendingTraySnapshotSignature;
    this.pendingTraySnapshotSignature = "";
    this.forceNextTrayFlush = false;
    this.logger.info(`AMS snapshot: ${trays.length} loaded tagged tray(s)`);
    Promise.resolve()
      .then(() => this.onTrays(trays))
      .then(() => {
        this.lastTraySnapshotSignature = signature;
      })
      .catch((error) => {
        this.logger.error("Sync failed:", error.stack || error.message);
      });
  }

  stop() {
    clearInterval(this.pushAllTimer);
    clearTimeout(this.debounceTimer);
    this.connected = false;
    this.client?.end(true);
  }

  status() {
    return {
      connected: this.connected,
      printerSerial: this.config.printerSerial,
      connectionMode: this.config.connectionMode,
      lastTrayCount: this.lastTrays.length
    };
  }
}
