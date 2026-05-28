import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULTS = {
  BAMBU_CONNECTION_MODE: "cloud",
  BAMBU_PRINTER_SERIAL: "",
  BAMBU_PRINTER_IP: "",
  BAMBU_ACCESS_CODE: "",
  BAMBU_PRINTER_NAME: "",
  BAMBU_CLOUD_TOKEN_FILE: ".bambu-cloud.json",
  NOTION_TOKEN: "",
  NOTION_DATA_SOURCE_ID: "",
  NOTION_AMS_DATABASE_NAME: "AMS 耗材",
  NOTION_TASK_DATABASE_NAME: "打印记录",
  NOTION_TASK_FILAMENT_DATABASE_NAME: "耗材用量明细",
  NOTION_TASK_FILAMENT_SPEC_DATABASE_NAME: "耗材色卡",
  NOTION_TITLE_PROP: "AMS 耗材",
  DRY_RUN: "true",
  PRINT_TASK_HISTORY_SYNC_ON_START: "true",
  PRINT_TASK_HISTORY_LIMIT: "0",
  PRINT_TASK_UPDATE_INTERVAL_MS: "120000",
  PUSHALL_INTERVAL_MS: "600000",
  LOG_LEVEL: "info"
};

const SECRET_KEYS = new Set(["NOTION_TOKEN", "BAMBU_ACCESS_CODE"]);

export function configFilePath() {
  return resolve(process.env.APP_CONFIG_FILE || ".app-config.json");
}

export async function loadStoredConfig() {
  const file = configFilePath();
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
  } catch {
    saved = {};
  }

  const envConfig = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (process.env[key] != null && process.env[key] !== "") {
      envConfig[key] = process.env[key];
    }
  }

  return { ...DEFAULTS, ...envConfig, ...saved };
}

export async function saveStoredConfig(config) {
  const file = configFilePath();
  const sanitized = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (config[key] != null) sanitized[key] = String(config[key]);
    else sanitized[key] = fallback;
  }

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return sanitized;
}

export async function resetStoredConfig(preserve = {}) {
  return saveStoredConfig({ ...DEFAULTS, ...preserve });
}

export function maskConfig(config) {
  const masked = { ...config };
  for (const key of SECRET_KEYS) {
    masked[key] = masked[key] ? "********" : "";
  }
  return masked;
}

export function mergeConfig(existing, patch) {
  const next = { ...existing };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] == null) continue;
    if (SECRET_KEYS.has(key) && patch[key] === "********") continue;
    next[key] = String(patch[key]);
  }
  return next;
}
