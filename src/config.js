import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value.trim();
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function int(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function csv(name, fallback) {
  return optional(name, fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function notionId(name) {
  const raw = required(name);
  const compact = raw.replace(/-/g, "");
  const match = compact.match(/[0-9a-fA-F]{32}(?!.*[0-9a-fA-F]{32})/);
  if (!match) {
    throw new Error(`${name} must contain a 32-character Notion id`);
  }
  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function loadCloudToken(tokenFile) {
  try {
    return JSON.parse(readFileSync(tokenFile, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Bambu cloud token file "${tokenFile}". Run npm run cloud:login first.`);
  }
}

export function loadConfig() {
  const connectionMode = optional("BAMBU_CONNECTION_MODE", "cloud").toLowerCase();
  if (!["local", "cloud"].includes(connectionMode)) {
    throw new Error("BAMBU_CONNECTION_MODE must be local or cloud");
  }

  const cloudTokenFile = resolve(optional("BAMBU_CLOUD_TOKEN_FILE", ".bambu-cloud.json"));
  const cloudToken = connectionMode === "cloud" ? loadCloudToken(cloudTokenFile) : null;

  return {
    bambu: {
      connectionMode,
      printerIp: connectionMode === "local" ? required("BAMBU_PRINTER_IP") : optional("BAMBU_PRINTER_IP"),
      printerSerial: required("BAMBU_PRINTER_SERIAL"),
      accessCode: connectionMode === "local" ? required("BAMBU_ACCESS_CODE") : optional("BAMBU_ACCESS_CODE"),
      printerName: optional("BAMBU_PRINTER_NAME", optional("BAMBU_PRINTER_SERIAL")),
      cloudTokenFile,
      cloud: cloudToken
        ? {
            region: cloudToken.region,
            broker: cloudToken.mqttBroker,
            uid: cloudToken.uid,
            accessToken: cloudToken.accessToken
          }
        : null,
      uidFields: csv("BAMBU_UID_FIELDS", "tag_uid,tray_uuid"),
      defaultSpoolWeightGrams: int("DEFAULT_SPOOL_WEIGHT_GRAMS", 1000),
      correctRemainForTrayWeight: bool("CORRECT_REMAIN_FOR_TRAY_WEIGHT", true),
      pushAllOnStart: bool("PUSHALL_ON_START", true),
      pushAllIntervalMs: int("PUSHALL_INTERVAL_MS", 300000),
      syncDebounceMs: int("SYNC_DEBOUNCE_MS", 3000),
      rejectUnauthorized: bool("MQTT_REJECT_UNAUTHORIZED", connectionMode === "cloud")
    },
    notion: {
      token: required("NOTION_TOKEN"),
      dataSourceId: notionId("NOTION_DATA_SOURCE_ID"),
      amsDatabaseName: optional("NOTION_AMS_DATABASE_NAME", "AMS 耗材"),
      properties: {
        amsUid: optional("NOTION_AMS_UID_PROP", "RFID Tag UID"),
        remainPercent: optional("NOTION_REMAIN_PERCENT_PROP", "余量%"),
        remainGrams: optional("NOTION_REMAIN_GRAMS_PROP", "剩余克数"),
        amsSlot: optional("NOTION_AMS_SLOT_PROP"),
        loaded: optional("NOTION_LOADED_PROP"),
        lastSync: optional("NOTION_LAST_SYNC_PROP", "最后同步时间"),
        printer: optional("NOTION_PRINTER_PROP"),
        material: optional("NOTION_MATERIAL_PROP", "材料"),
        color: optional("NOTION_COLOR_PROP", "颜色"),
        tagUid: optional("NOTION_TAG_UID_PROP"),
        trayUuid: optional("NOTION_TRAY_UUID_PROP", "Tray UUID"),
        trayWeight: optional("NOTION_TRAY_WEIGHT_PROP", "料盘重量g"),
        title: optional("NOTION_TITLE_PROP", "AMS 耗材")
      },
      createMissingPages: bool("CREATE_MISSING_PAGES", true),
      missingPageTitlePrefix: optional("MISSING_PAGE_TITLE_PREFIX", "待绑定耗材"),
      clearAbsentLoaded: bool("CLEAR_ABSENT_LOADED", false)
    },
    dryRun: bool("DRY_RUN", true),
    logLevel: optional("LOG_LEVEL", "info")
  };
}
