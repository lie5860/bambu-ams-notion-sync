import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function requiredFrom(source, name) {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optionalFrom(source, name, fallback = "") {
  const value = source[name];
  return value == null || value === "" ? fallback : value.trim();
}

function boolFrom(source, name, fallback = false) {
  const value = source[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function intFrom(source, name, fallback) {
  const value = source[name];
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function csvFrom(source, name, fallback) {
  return optionalFrom(source, name, fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
      taskDatabaseName: optionalFrom(source, "NOTION_TASK_DATABASE_NAME", "打印记录"),
      taskFilamentDatabaseName: optionalFrom(source, "NOTION_TASK_FILAMENT_DATABASE_NAME", "耗材用量明细"),
      taskFilamentSpecDatabaseName: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_DATABASE_NAME", "耗材色卡"),
      taskFilamentColorDatabaseName: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_DATABASE_NAME", "颜色映射"),
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
        colorList: optionalFrom(source, "NOTION_COLOR_LIST_PROP", "颜色列表"),
        colorType: optionalFrom(source, "NOTION_COLOR_TYPE_PROP", "颜色类型"),
        colorAlias: optionalFrom(source, "NOTION_COLOR_ALIAS_PROP", "颜色别名"),
        tagUid: optionalFrom(source, "NOTION_TAG_UID_PROP"),
        trayUuid: optionalFrom(source, "NOTION_TRAY_UUID_PROP", "Tray UUID"),
        trayWeight: optionalFrom(source, "NOTION_TRAY_WEIGHT_PROP", "料盘重量g"),
        title: optionalFrom(source, "NOTION_TITLE_PROP", "AMS 耗材")
      },
      taskProperties: {
        title: optionalFrom(source, "NOTION_TASK_TITLE_PROP", "打印任务"),
        taskKey: optionalFrom(source, "NOTION_TASK_KEY_PROP", "任务 Key"),
        taskId: optionalFrom(source, "NOTION_TASK_ID_PROP", "Task ID"),
        printer: optionalFrom(source, "NOTION_TASK_PRINTER_PROP", "打印机"),
        printerSerial: optionalFrom(source, "NOTION_TASK_PRINTER_SERIAL_PROP", "Printer Serial"),
        status: optionalFrom(source, "NOTION_TASK_STATUS_PROP", "状态"),
        statusCode: optionalFrom(source, "NOTION_TASK_STATUS_CODE_PROP", "状态码"),
        syncStatus: optionalFrom(source, "NOTION_TASK_SYNC_STATUS_PROP", "同步状态"),
        mergedTo: optionalFrom(source, "NOTION_TASK_MERGED_TO_PROP", "合并到任务 Key"),
        printConfig: optionalFrom(source, "NOTION_TASK_PRINT_CONFIG_PROP", "打印配置"),
        startTime: optionalFrom(source, "NOTION_TASK_START_TIME_PROP", "开始时间"),
        endTime: optionalFrom(source, "NOTION_TASK_END_TIME_PROP", "结束时间"),
        durationMinutes: optionalFrom(source, "NOTION_TASK_DURATION_MINUTES_PROP", "耗时分钟"),
        progress: optionalFrom(source, "NOTION_TASK_PROGRESS_PROP", "进度%"),
        layers: optionalFrom(source, "NOTION_TASK_LAYERS_PROP", "层数"),
        filamentWeight: optionalFrom(source, "NOTION_TASK_FILAMENT_WEIGHT_PROP", "耗材总量g"),
        filamentLength: optionalFrom(source, "NOTION_TASK_FILAMENT_LENGTH_PROP", "耗材长度m"),
        usedSlots: optionalFrom(source, "NOTION_TASK_USED_SLOTS_PROP", "使用槽位"),
        filamentDetails: optionalFrom(source, "NOTION_TASK_FILAMENT_DETAILS_PROP", "耗材明细"),
        usedFilaments: optionalFrom(source, "NOTION_TASK_USED_FILAMENTS_PROP", "使用耗材"),
        filamentUsages: optionalFrom(source, "NOTION_TASK_FILAMENT_USAGES_PROP", "耗材用量"),
        thumbnail: optionalFrom(source, "NOTION_TASK_THUMBNAIL_PROP", "任务缩略图"),
        snapshot: optionalFrom(source, "NOTION_TASK_SNAPSHOT_PROP", "完成截图"),
        displayImage: optionalFrom(source, "NOTION_TASK_DISPLAY_IMAGE_PROP", "展示图片"),
        rawCoverUrl: optionalFrom(source, "NOTION_TASK_RAW_COVER_URL_PROP", "原始封面URL"),
        rawSnapshotUrl: optionalFrom(source, "NOTION_TASK_RAW_SNAPSHOT_URL_PROP", "原始截图URL"),
        lastSync: optionalFrom(source, "NOTION_TASK_LAST_SYNC_PROP", "最后同步时间")
      },
      taskFilamentProperties: {
        title: optionalFrom(source, "NOTION_TASK_FILAMENT_TITLE_PROP", "任务耗材"),
        detailKey: optionalFrom(source, "NOTION_TASK_FILAMENT_KEY_PROP", "明细 Key"),
        task: optionalFrom(source, "NOTION_TASK_FILAMENT_TASK_PROP", "打印任务"),
        spec: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_PROP", "耗材规格"),
        taskKey: optionalFrom(source, "NOTION_TASK_FILAMENT_TASK_KEY_PROP", "任务 Key"),
        taskId: optionalFrom(source, "NOTION_TASK_FILAMENT_TASK_ID_PROP", "Task ID"),
        slot: optionalFrom(source, "NOTION_TASK_FILAMENT_SLOT_PROP", "槽位"),
        material: optionalFrom(source, "NOTION_TASK_FILAMENT_MATERIAL_PROP", "材料"),
        color: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_PROP", "颜色"),
        weight: optionalFrom(source, "NOTION_TASK_FILAMENT_WEIGHT_PROP", "用量g"),
        percent: optionalFrom(source, "NOTION_TASK_FILAMENT_PERCENT_PROP", "占比%"),
        startTime: optionalFrom(source, "NOTION_TASK_FILAMENT_START_TIME_PROP", "开始时间"),
        status: optionalFrom(source, "NOTION_TASK_FILAMENT_STATUS_PROP", "任务状态"),
        lastSync: optionalFrom(source, "NOTION_TASK_FILAMENT_LAST_SYNC_PROP", "最后同步时间")
      },
      taskFilamentSpecProperties: {
        title: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_TITLE_PROP", "耗材规格"),
        specKey: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_KEY_PROP", "规格 Key"),
        material: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_MATERIAL_PROP", "材料"),
        color: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_COLOR_PROP", "颜色"),
        lastSync: optionalFrom(source, "NOTION_TASK_FILAMENT_SPEC_LAST_SYNC_PROP")
      },
      taskFilamentColorProperties: {
        title: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_TITLE_PROP", "色号"),
        colorKey: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_KEY_PROP", "颜色 Key"),
        alias: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_ALIAS_PROP", "颜色别名"),
        lastSync: optionalFrom(source, "NOTION_TASK_FILAMENT_COLOR_LAST_SYNC_PROP")
      },
      createMissingPages: boolFrom(source, "CREATE_MISSING_PAGES", true),
      missingPageTitlePrefix: optionalFrom(source, "MISSING_PAGE_TITLE_PREFIX", "待绑定耗材"),
      clearAbsentLoaded: boolFrom(source, "CLEAR_ABSENT_LOADED", false),
      amsSyncEnabled: boolFrom(source, "AMS_SYNC_ENABLED", false),
      printTaskUpdateIntervalMs: intFrom(source, "PRINT_TASK_UPDATE_INTERVAL_MS", 120000),
      printTaskProgressStep: intFrom(source, "PRINT_TASK_PROGRESS_STEP", 5),
      printTaskHistorySyncOnStart: boolFrom(source, "PRINT_TASK_HISTORY_SYNC_ON_START", false),
      printTaskHistoryLimit: intFrom(source, "PRINT_TASK_HISTORY_LIMIT", 0),
      printTaskHistoryPageSize: intFrom(source, "PRINT_TASK_HISTORY_PAGE_SIZE", 100),
      printTaskHistoryMinIntervalMs: intFrom(source, "PRINT_TASK_HISTORY_MIN_INTERVAL_MS", 300000),
      printTaskHistoryLastTaskTime: optionalFrom(source, "PRINT_TASK_HISTORY_LAST_TASK_TIME")
    },
    dryRun: boolFrom(source, "DRY_RUN", true),
    logLevel: optionalFrom(source, "LOG_LEVEL", "info")
  };
}
