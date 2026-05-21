import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name) {
  return requiredFrom(process.env, name);
}

function requiredFrom(source, name) {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name, fallback = "") {
  return optionalFrom(process.env, name, fallback);
}

function optionalFrom(source, name, fallback = "") {
  const value = source[name];
  return value == null || value === "" ? fallback : value.trim();
}

function bool(name, fallback = false) {
  return boolFrom(process.env, name, fallback);
}

function boolFrom(source, name, fallback = false) {
  const value = source[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function int(name, fallback) {
  return intFrom(process.env, name, fallback);
}

function intFrom(source, name, fallback) {
  const value = source[name];
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function csv(name, fallback) {
  return csvFrom(process.env, name, fallback);
}

function csvFrom(source, name, fallback) {
  return optionalFrom(source, name, fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function notionId(name) {
  return notionIdFrom(process.env, name);
}

function notionIdFrom(source, name) {
  const raw = requiredFrom(source, name);
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
    throw new Error(`Cannot read Bambu cloud token file "${tokenFile}". Log in from the Web console first.`);
  }
}

export function loadConfig(source = process.env) {
  const connectionMode = optionalFrom(source, "BAMBU_CONNECTION_MODE", "cloud").toLowerCase();
  if (!["local", "cloud"].includes(connectionMode)) {
    throw new Error("BAMBU_CONNECTION_MODE must be local or cloud");
  }

  const cloudTokenFile = resolve(optionalFrom(source, "BAMBU_CLOUD_TOKEN_FILE", ".bambu-cloud.json"));
  const cloudToken = connectionMode === "cloud" ? loadCloudToken(cloudTokenFile) : null;

  return {
    bambu: {
      connectionMode,
      printerIp: connectionMode === "local" ? requiredFrom(source, "BAMBU_PRINTER_IP") : optionalFrom(source, "BAMBU_PRINTER_IP"),
      printerSerial: requiredFrom(source, "BAMBU_PRINTER_SERIAL"),
      accessCode: connectionMode === "local" ? requiredFrom(source, "BAMBU_ACCESS_CODE") : optionalFrom(source, "BAMBU_ACCESS_CODE"),
      printerName: optionalFrom(source, "BAMBU_PRINTER_NAME", optionalFrom(source, "BAMBU_PRINTER_SERIAL")),
      cloudTokenFile,
      cloud: cloudToken
        ? {
            region: cloudToken.region,
            broker: cloudToken.mqttBroker,
            uid: cloudToken.uid,
            accessToken: cloudToken.accessToken
          }
        : null,
      uidFields: csvFrom(source, "BAMBU_UID_FIELDS", "tag_uid,tray_uuid"),
      defaultSpoolWeightGrams: intFrom(source, "DEFAULT_SPOOL_WEIGHT_GRAMS", 1000),
      correctRemainForTrayWeight: boolFrom(source, "CORRECT_REMAIN_FOR_TRAY_WEIGHT", true),
      pushAllOnStart: boolFrom(source, "PUSHALL_ON_START", true),
      pushAllIntervalMs: intFrom(source, "PUSHALL_INTERVAL_MS", 600000),
      syncDebounceMs: intFrom(source, "SYNC_DEBOUNCE_MS", 3000),
      rejectUnauthorized: boolFrom(source, "MQTT_REJECT_UNAUTHORIZED", connectionMode === "cloud")
    },
    notion: {
      token: requiredFrom(source, "NOTION_TOKEN"),
      dataSourceId: notionIdFrom(source, "NOTION_DATA_SOURCE_ID"),
      amsDatabaseName: optionalFrom(source, "NOTION_AMS_DATABASE_NAME", "AMS 耗材"),
      properties: {
        amsUid: optionalFrom(source, "NOTION_AMS_UID_PROP", "RFID Tag UID"),
        remainPercent: optionalFrom(source, "NOTION_REMAIN_PERCENT_PROP", "余量%"),
        remainGrams: optionalFrom(source, "NOTION_REMAIN_GRAMS_PROP", "剩余克数"),
        amsSlot: optionalFrom(source, "NOTION_AMS_SLOT_PROP"),
        loaded: optionalFrom(source, "NOTION_LOADED_PROP"),
        lastSync: optionalFrom(source, "NOTION_LAST_SYNC_PROP", "最后同步时间"),
        printer: optionalFrom(source, "NOTION_PRINTER_PROP"),
        material: optionalFrom(source, "NOTION_MATERIAL_PROP", "材料"),
        color: optionalFrom(source, "NOTION_COLOR_PROP", "颜色"),
        tagUid: optionalFrom(source, "NOTION_TAG_UID_PROP"),
        trayUuid: optionalFrom(source, "NOTION_TRAY_UUID_PROP", "Tray UUID"),
        trayWeight: optionalFrom(source, "NOTION_TRAY_WEIGHT_PROP", "料盘重量g"),
        title: optionalFrom(source, "NOTION_TITLE_PROP", "AMS 耗材")
      },
      createMissingPages: boolFrom(source, "CREATE_MISSING_PAGES", true),
      missingPageTitlePrefix: optionalFrom(source, "MISSING_PAGE_TITLE_PREFIX", "待绑定耗材"),
      clearAbsentLoaded: boolFrom(source, "CLEAR_ABSENT_LOADED", false)
    },
    dryRun: boolFrom(source, "DRY_RUN", true),
    logLevel: optionalFrom(source, "LOG_LEVEL", "info")
  };
}
