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
  return value.startsWith("#") ? value : `#${value.slice(0, 6)}`;
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

      trays.push({
        uid,
        tagUid: isZeroish(slot.tag_uid) ? "" : String(slot.tag_uid),
        trayUuid: isZeroish(slot.tray_uuid) ? "" : String(slot.tray_uuid),
        amsId: String(ams.id ?? ""),
        slotId: String(slot.id ?? ""),
        slotLabel: slotLabel(ams.id, slot.id),
        material: slot.tray_sub_brands || slot.tray_type || "",
        trayType: slot.tray_type || "",
        color: normalizeHexColor(slot.tray_color || slot.cols?.[0] || ""),
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
  constructor(config, logger, onTrays, onPrinterStatus = null) {
    this.config = config;
    this.logger = logger;
    this.onTrays = onTrays;
    this.onPrinterStatus = onPrinterStatus;
    this.client = null;
    this.pushAllTimer = null;
    this.debounceTimer = null;
    this.lastTrays = [];
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
    return this.requestPushAll("manual");
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

    const trays = extractAmsTrays({ print: this.lastPrintState }, this.config);
    if (trays.length === 0) return;

    this.lastTrays = trays;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushTrays(), this.config.syncDebounceMs);
  }

  flushTrays() {
    this.logger.info(`AMS snapshot: ${this.lastTrays.length} loaded tagged tray(s)`);
    this.onTrays(this.lastTrays).catch((error) => {
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
