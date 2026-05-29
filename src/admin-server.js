import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { CLOUD_REGIONS, loadCloudToken, loginWithCode, loginWithPassword, loginWithTfa, saveCloudToken } from "./cloud-auth.js";
import { loadConfig } from "./config.js";
import { loadStoredConfig, maskConfig, mergeConfig, resetStoredConfig, saveStoredConfig } from "./config-store.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 3030);
const ADMIN_UI_TEMPLATE = new URL("./admin-ui/index.html", import.meta.url);
const ADMIN_UI_RELOAD_PATH = "/__admin-ui-reload";
const ADMIN_UI_RELOAD_ENABLED = process.env.ADMIN_UI_RELOAD === "1";
const TASK_HISTORY_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function isSetupError(error) {
  return (
    error.message?.startsWith("Missing required env:") ||
    error.message?.startsWith("Cannot read Bambu cloud token file")
  );
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

async function removeIfExists(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function configEnabled(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").toLowerCase());
}

function syncFlagsFromStored(config) {
  return {
    ams: configEnabled(config.AMS_SYNC_ENABLED),
    printHistory: configEnabled(config.PRINT_TASK_HISTORY_SYNC_ON_START)
  };
}

function taskHistoryOverlapStart(checkpoint) {
  const checkpointMs = Date.parse(checkpoint || "");
  if (!Number.isFinite(checkpointMs)) return "";
  return new Date(Math.max(0, checkpointMs - TASK_HISTORY_OVERLAP_MS)).toISOString();
}

class SyncRuntime {
  constructor() {
    this.logger = createLogger(process.env.LOG_LEVEL || "info");
    this.bambuClient = null;
    this.notionSync = null;
    this.taskHistoryTimer = null;
    this.taskHistorySyncRunning = false;
    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    this.maintenanceRunning = false;
    this.pendingManualSync = false;
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
    this.lastTaskHistorySyncAt = "";
    this.lastTaskHistoryCount = 0;
    this.lastTaskHistoryCheckpointAt = "";
    this.enabledSyncs = { ams: false, printHistory: false };
  }

  async restart({ forceTaskHistorySync = false } = {}) {
    await this.stop();
    const stored = await loadStoredConfig();
    this.enabledSyncs = syncFlagsFromStored(stored);
    if (!this.enabledSyncs.ams && !this.enabledSyncs.printHistory) {
      this.lastError = "";
      this.logger.info("All sync features are disabled; waiting for the user to enable AMS or print history sync");
      return;
    }

    this.starting = true;
    this.startupPhase = "加载配置";
    this.lastError = "";

    try {
      const config = loadConfig({ ...process.env, ...stored });
      const notionConfig = {
        ...config.notion,
        dryRun: config.dryRun,
        printerName: config.bambu.printerName,
        printerSerial: config.bambu.printerSerial
      };

      this.logger = createLogger(config.logLevel);
      this.notionSync = new NotionAmsSync(notionConfig, this.logger);
      this.startupPhase = "初始化 Notion";
      await this.notionSync.init({
        deferMaintenance: true,
        enableAmsSync: config.notion.amsSyncEnabled,
        enablePrintTaskSync: config.notion.printTaskHistorySyncOnStart
      });

      if (config.notion.amsSyncEnabled) {
        this.startupPhase = "连接打印机";
        this.bambuClient = new BambuMqttClient(
          config.bambu,
          this.logger,
          async (trays) => {
            this.lastSyncAt = new Date().toISOString();
            this.lastTrayCount = trays.length;
            await this.notionSync.syncTrays(trays);
          },
          config.notion.printTaskHistorySyncOnStart
            ? (printState) => this.notionSync.syncPrinterStatus(printState)
            : null,
          () => this.flushPendingManualSync()
        );
        this.bambuClient.start();
      }
      this.running = true;
      this.starting = false;
      this.startupPhase = "";
      this.lastError = "";
      this.runStartupMaintenance().catch((error) => {
        this.logger.error("Startup maintenance failed:", error.stack || error.message);
      });
      this.syncPrintTaskHistory(config, { ignoreCooldown: forceTaskHistorySync }).catch((error) => {
        this.logger.error("Print task history sync failed:", error.stack || error.message);
      });
      this.schedulePrintTaskHistorySync(config);
    } catch (error) {
      this.running = false;
      this.starting = false;
      this.startupPhase = "";
      this.pendingManualSync = false;
      this.lastError = error.message;
      if (isSetupError(error)) {
        this.logger.warn("Sync service waiting for setup:", error.message);
      } else {
        this.logger.error("Sync service not started:", error.message);
      }
    }
  }

  async runStartupMaintenance() {
    if (!this.notionSync || this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      await this.notionSync.runStartupMaintenance();
    } finally {
      this.maintenanceRunning = false;
    }
  }

  flushPendingManualSync() {
    if (!this.pendingManualSync) return;
    this.pendingManualSync = false;
    const ok = this.bambuClient?.requestManualSync();
    if (!ok) this.pendingManualSync = true;
  }

  async stop() {
    clearInterval(this.taskHistoryTimer);
    this.taskHistoryTimer = null;
    this.taskHistorySyncRunning = false;
    this.bambuClient?.stop();
    this.bambuClient = null;
    this.notionSync = null;
    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    this.maintenanceRunning = false;
    this.pendingManualSync = false;
  }

  async reset() {
    await this.stop();
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
    this.lastTaskHistorySyncAt = "";
    this.lastTaskHistoryCount = 0;
    this.lastTaskHistoryCheckpointAt = "";
    this.enabledSyncs = { ams: false, printHistory: false };
  }

  async manualSync() {
    if (this.starting) {
      this.pendingManualSync = true;
      return {
        requested: false,
        pending: true,
        message: "同步服务正在启动，连接打印机后会自动执行这次同步。"
      };
    }

    const stored = await loadStoredConfig();
    const enabledSyncs = syncFlagsFromStored(stored);
    if (!enabledSyncs.ams && !enabledSyncs.printHistory) {
      throw new Error("请先打开至少一个同步开关");
    }

    const messages = [];
    let pending = false;
    if (enabledSyncs.ams) {
      if (!this.bambuClient) throw new Error("AMS 同步服务尚未运行");
      const ok = this.bambuClient.requestManualSync();
      if (!ok) {
        this.pendingManualSync = true;
        pending = true;
        messages.push("AMS 同步正在等待拓竹云连接；连接后会自动执行这次同步。");
      } else {
        messages.push("已请求打印机立即回报完整 AMS 状态。");
      }
    }

    if (enabledSyncs.printHistory) {
      const config = loadConfig({ ...process.env, ...stored });
      this.syncPrintTaskHistory(config, { ignoreCooldown: true }).catch((error) => {
        this.logger.error("Manual print task history sync failed:", error.stack || error.message);
      });
      messages.push("已开始同步打印历史。");
    }

    return { requested: !pending, pending, message: messages.join(" ") };
  }

  status() {
    return {
      running: this.running,
      starting: this.starting,
      startupPhase: this.startupPhase,
      maintenanceRunning: this.maintenanceRunning,
      pendingManualSync: this.pendingManualSync,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastTrayCount: this.lastTrayCount,
      lastTaskHistorySyncAt: this.lastTaskHistorySyncAt,
      lastTaskHistoryCount: this.lastTaskHistoryCount,
      lastTaskHistoryCheckpointAt: this.lastTaskHistoryCheckpointAt,
      enabledSyncs: this.enabledSyncs,
      bambu: this.bambuClient?.status() || null
    };
  }

  async refreshTaskHistoryTotalCount() {
    if (!this.notionSync) return this.lastTaskHistoryCount;
    try {
      const total = await this.notionSync.countPrintTaskPages();
      this.lastTaskHistoryCount = total;
      return total;
    } catch (error) {
      this.logger.warn(`Cannot count Notion print task history: ${error.message}`);
      return this.lastTaskHistoryCount;
    }
  }

  async syncPrintTaskHistory(config, { ignoreCooldown = false } = {}) {
    if (!config.notion.printTaskHistorySyncOnStart || !config.bambu.cloud?.accessToken || !this.notionSync) return;
    if (this.taskHistorySyncRunning) {
      this.logger.info("Skipping print task history sync; previous sync is still running");
      return;
    }

    this.taskHistorySyncRunning = true;
    try {
      const stored = await loadStoredConfig();
      const now = Date.now();
      this.lastTaskHistoryCheckpointAt = stored.PRINT_TASK_HISTORY_LAST_TASK_TIME || "";
      const lastStartedAt = Date.parse(stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || "");
      const minIntervalMs = Math.max(0, config.notion.printTaskHistoryMinIntervalMs || 0);
      if (!ignoreCooldown && minIntervalMs > 0 && Number.isFinite(lastStartedAt) && now - lastStartedAt < minIntervalMs) {
        const nextAt = new Date(lastStartedAt + minIntervalMs).toISOString();
        this.lastTaskHistorySyncAt = stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || this.lastTaskHistorySyncAt;
        await this.refreshTaskHistoryTotalCount();
        this.logger.info(`Skipping print task history sync; next allowed at ${nextAt}`);
        return;
      }

      const startedAt = new Date(now).toISOString();
      await saveStoredConfig({ ...stored, PRINT_TASK_HISTORY_LAST_SYNC_AT: startedAt });
      this.lastTaskHistorySyncAt = startedAt;
      const checkpoint = stored.PRINT_TASK_HISTORY_LAST_TASK_TIME || "";
      const sinceTime = taskHistoryOverlapStart(checkpoint);
      if (checkpoint && sinceTime) {
        this.logger.info(`Checking Bambu cloud print task history since ${sinceTime} with 2-day overlap`);
      }

      const tasks = await fetchCloudPrintTasks({
        cloud: config.bambu.cloud,
        printerSerial: config.bambu.printerSerial,
        limit: config.notion.printTaskHistoryLimit,
        pageSize: config.notion.printTaskHistoryPageSize,
        sinceTime,
        logger: this.logger
      });
      if (tasks.length === 0) {
        this.logger.info("No new Bambu cloud print task(s) to sync");
        await this.refreshTaskHistoryTotalCount();
        return;
      }

      const result = await this.notionSync.syncCloudPrintTasks(tasks, {
        onTaskSynced: async (_record, { lastTaskTime }) => {
          if (config.dryRun || !lastTaskTime) return;
          const latest = await loadStoredConfig();
          const currentMs = Date.parse(latest.PRINT_TASK_HISTORY_LAST_TASK_TIME || "");
          const nextMs = Date.parse(lastTaskTime);
          if (!Number.isFinite(nextMs)) return;
          if (Number.isFinite(currentMs) && nextMs <= currentMs) return;
          const nextTaskTime = new Date(nextMs).toISOString();
          await saveStoredConfig({ ...latest, PRINT_TASK_HISTORY_LAST_TASK_TIME: nextTaskTime });
          this.lastTaskHistoryCheckpointAt = nextTaskTime;
        }
      });
      this.lastTaskHistorySyncAt = startedAt;
      await this.refreshTaskHistoryTotalCount();
      this.logger.info(
        `Print task history sync finished: ${result.synced} checked, ${result.changed} changed, ${result.unchanged} unchanged, ${this.lastTaskHistoryCount} total, checkpoint ${this.lastTaskHistoryCheckpointAt || "unchanged"}`
      );
    } finally {
      this.taskHistorySyncRunning = false;
    }
  }

  schedulePrintTaskHistorySync(config) {
    clearInterval(this.taskHistoryTimer);
    this.taskHistoryTimer = null;
    if (!config.notion.printTaskHistorySyncOnStart || !config.bambu.cloud?.accessToken || !this.notionSync) return;

    const intervalMs = Math.max(60000, config.notion.printTaskHistoryMinIntervalMs || 300000);
    this.taskHistoryTimer = setInterval(() => {
      this.syncPrintTaskHistory(config).catch((error) => {
        this.logger.error("Scheduled print task history sync failed:", error.stack || error.message);
      });
    }, intervalMs);
    this.taskHistoryTimer.unref?.();
    this.logger.info(`Scheduled print task history sync every ${intervalMs}ms`);
  }
}

const runtime = new SyncRuntime();
const uiReloadClients = new Set();
let uiReloadWatcher = null;
let pendingUiReload = null;

function injectDevReload(html) {
  if (!ADMIN_UI_RELOAD_ENABLED) return html;
  return html.replace(
    "</body>",
    `  <script>
    (() => {
      const source = new EventSource("${ADMIN_UI_RELOAD_PATH}");
      source.addEventListener("message", (event) => {
        if (event.data === "reload") window.location.reload();
      });
    })();
  </script>
</body>`
  );
}

function handleUiReload(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive"
  });
  res.write("retry: 500\n\n");
  uiReloadClients.add(res);
  req.on("close", () => {
    uiReloadClients.delete(res);
  });
}

function sendUiReload() {
  for (const client of uiReloadClients) {
    client.write("data: reload\n\n");
  }
}

function startUiReloadWatcher() {
  if (!ADMIN_UI_RELOAD_ENABLED || uiReloadWatcher) return;
  uiReloadWatcher = watch(ADMIN_UI_TEMPLATE, { persistent: false }, () => {
    clearTimeout(pendingUiReload);
    pendingUiReload = setTimeout(sendUiReload, 75);
    pendingUiReload.unref?.();
  });
  uiReloadWatcher.on("error", (error) => {
    console.warn(`Admin UI reload watcher failed: ${error.message}`);
  });
}

function regionOptions() {
  return Object.entries(CLOUD_REGIONS)
    .map(([value, region]) => {
      const label = value === "china" ? "中国区" : value === "global" ? "海外区" : region.label;
      const labelKey = value === "china" ? "region.china" : value === "global" ? "region.global" : "";
      return `<option value="${value}"${labelKey ? ` data-i18n="${labelKey}"` : ""}>${label}</option>`;
    })
    .join("");
}

async function page() {
  const template = await readFile(ADMIN_UI_TEMPLATE, "utf8");
  return injectDevReload(template.replace("{{REGION_OPTIONS}}", regionOptions()));
}

function maskedTokenData(token) {
  if (!token) return null;
  return {
    region: token.region,
    uid: token.uid,
    mqttBroker: token.mqttBroker,
    expiresAt: token.expiresAt,
    savedAt: token.savedAt,
    devices: token.devices || []
  };
}

async function saveBambuToken(body) {
  const settings = await loadStoredConfig();
  const tokenFile = resolve(settings.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
  await saveCloudToken(tokenFile, body.token);
  if (!settings.BAMBU_PRINTER_SERIAL && body.token.devices?.length === 1) {
    settings.BAMBU_PRINTER_SERIAL = body.token.devices[0].dev_id;
    settings.BAMBU_PRINTER_NAME = body.token.devices[0].name || settings.BAMBU_PRINTER_NAME;
    await saveStoredConfig(settings);
  }
  await runtime.restart();
}

async function resetBambuLogin() {
  const existing = await loadStoredConfig();
  const tokenFile = resolve(existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
  await runtime.reset();
  await removeIfExists(tokenFile);
  await saveStoredConfig({
    ...existing,
    BAMBU_CONNECTION_MODE: "cloud",
    BAMBU_PRINTER_SERIAL: "",
    BAMBU_PRINTER_NAME: "",
    BAMBU_PRINTER_IP: "",
    BAMBU_ACCESS_CODE: ""
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === "/api/status" && req.method === "GET") {
      const config = await loadStoredConfig();
      let token = null;
      try {
        token = await loadCloudToken(resolve(config.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json"));
      } catch {
        token = null;
      }
      sendJson(res, 200, { config: maskConfig(config), bambuToken: maskedTokenData(token), runtime: runtime.status() });
      return;
    }

    const body = await parseBody(req);

    if (pathname === "/api/config" && req.method === "POST") {
      const existing = await loadStoredConfig();
      const next = mergeConfig(existing, body);
      await saveStoredConfig(next);
      await runtime.restart({
        forceTaskHistorySync:
          !configEnabled(existing.PRINT_TASK_HISTORY_SYNC_ON_START) &&
          configEnabled(next.PRINT_TASK_HISTORY_SYNC_ON_START)
      });
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/restart" && req.method === "POST") {
      await runtime.restart();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/sync" && req.method === "POST") {
      sendJson(res, 200, await runtime.manualSync());
      return;
    }

    if (pathname === "/api/task-history/checkpoint/reset" && req.method === "POST") {
      const existing = await loadStoredConfig();
      await saveStoredConfig({
        ...existing,
        PRINT_TASK_HISTORY_LAST_TASK_TIME: "",
        PRINT_TASK_HISTORY_LAST_SYNC_AT: ""
      });
      runtime.lastTaskHistorySyncAt = "";
      await runtime.refreshTaskHistoryTotalCount();
      runtime.lastTaskHistoryCheckpointAt = "";
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/bambu/reset" && req.method === "POST") {
      if (!["重置", "RESET"].includes(body.confirmation)) {
        sendJson(res, 400, { error: "请输入“重置”确认操作" });
        return;
      }

      await resetBambuLogin();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/reset" && req.method === "POST") {
      if (!["重置", "RESET"].includes(body.confirmation)) {
        sendJson(res, 400, { error: "请输入“重置”确认操作" });
        return;
      }

      const existing = await loadStoredConfig();
      const tokenFile = resolve(existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
      await runtime.reset();
      await removeIfExists(tokenFile);
      await resetStoredConfig({
        BAMBU_CLOUD_TOKEN_FILE: existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json"
      });
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/bambu/login" && req.method === "POST") {
      const result = await loginWithPassword(body);
      if (result.token) {
        await saveBambuToken(result);
        sendJson(res, 200, { token: maskedTokenData(result.token) });
      } else {
        sendJson(res, 200, result);
      }
      return;
    }

    if (pathname === "/api/bambu/verify" && req.method === "POST") {
      const result = await loginWithCode(body);
      await saveBambuToken(result);
      sendJson(res, 200, { token: maskedTokenData(result.token) });
      return;
    }

    if (pathname === "/api/bambu/tfa" && req.method === "POST") {
      const result = await loginWithTfa(body);
      await saveBambuToken(result);
      sendJson(res, 200, { token: maskedTokenData(result.token) });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (ADMIN_UI_RELOAD_ENABLED && url.pathname === ADMIN_UI_RELOAD_PATH) {
    handleUiReload(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url.pathname);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(await page());
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(res, 500, { error: error.message });
  });
});

server.listen(PORT, HOST, async () => {
  console.log(`Admin UI: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  startUiReloadWatcher();
  await runtime.restart();
});

process.on("SIGINT", async () => {
  uiReloadWatcher?.close();
  await runtime.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  uiReloadWatcher?.close();
  await runtime.stop();
  process.exit(0);
});
