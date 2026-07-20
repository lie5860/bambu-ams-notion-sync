import { createServer } from "node:http";
import { watch } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { CLOUD_REGIONS, loadCloudToken, loginWithCode, loginWithPassword, loginWithTfa, saveCloudToken } from "./cloud-auth.js";
import { loadConfig } from "./config.js";
import {
  loadStoredConfig,
  maskConfig,
  mergeConfig,
  resetStoredConfig,
  saveStoredConfig,
  updateStoredConfig
} from "./config-store.js";
import { createLogger } from "./logger.js";
import { awaitWithSignal, parseBody } from "./http.js";
import { NotionAmsSync } from "./notion-sync.js";

const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 3030);
const ADMIN_UI_TEMPLATE = new URL("./admin-ui/index.html", import.meta.url);
const ADMIN_UI_RELOAD_PATH = "/__admin-ui-reload";
const ADMIN_UI_RELOAD_ENABLED = process.env.ADMIN_UI_RELOAD === "1";
const TASK_HISTORY_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
const STARTUP_RETRY_BASE_MS = 5_000;
const STARTUP_RETRY_MAX_MS = 5 * 60 * 1000;
const TASK_HISTORY_RETRY_BASE_MS = 15_000;
const TASK_HISTORY_RETRY_MAX_MS = 5 * 60 * 1000;
const TASK_HISTORY_STOP_WAIT_MS = 2_000;
const MAINTENANCE_RETRY_BASE_MS = 30_000;
const MAINTENANCE_RETRY_MAX_MS = 10 * 60 * 1000;

const TRANSIENT_STARTUP_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "INVALID_HTTP_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "bad_gateway",
  "conflict_error",
  "gateway_timeout",
  "internal_server_error",
  "notionhq_client_request_timeout",
  "rate_limited",
  "service_unavailable"
]);

const PERMANENT_REQUEST_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UND_ERR_INVALID_ARG",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "invalid_json",
  "invalid_request",
  "invalid_request_url",
  "object_not_found",
  "restricted_resource",
  "unauthorized"
]);

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(body));
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  }
}

function isSetupError(error) {
  const message = error?.message || "";
  return (
    message.startsWith("Missing required env:") ||
    message.startsWith("Cannot read Bambu cloud token file")
  );
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

export function isRetryableStartupError(error) {
  const chain = errorChain(error);
  const hasPermanentFailure = chain.some((item) => {
    const status = Number(item.status || item.statusCode);
    if (status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)) return true;
    return PERMANENT_REQUEST_ERROR_CODES.has(String(item.code || ""));
  });
  if (hasPermanentFailure) return false;

  return chain.some((item) => {
    const status = Number(item.status || item.statusCode);
    if ([408, 409, 425, 429].includes(status) || (status >= 500 && status < 600)) return true;

    const code = String(item.code || "");
    if (TRANSIENT_STARTUP_ERROR_CODES.has(code)) return true;

    const message = String(item.message || "").toLowerCase();
    return (
      message === "fetch failed" ||
      message.includes("network error") ||
      message.includes("request aborted") ||
      message.includes("request timed out") ||
      message.includes("request timeout")
    );
  });
}

export function startupRetryDelay(attempt, {
  baseMs = STARTUP_RETRY_BASE_MS,
  maxMs = STARTUP_RETRY_MAX_MS,
  random = Math.random
} = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(Math.min(maxMs, exponential * jitter)));
}

function startupErrorDetails(error) {
  return errorChain(error)
    .map((item) => {
      const message = String(item.message || "").trim();
      const code = String(item.code || "").trim();
      if (!message) return code;
      return code && !message.includes(code) ? `${message} (${code})` : message;
    })
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("; caused by: ");
}

function errorMessage(error) {
  return error?.message || String(error);
}

function errorLogDetails(error) {
  return error?.stack || errorMessage(error);
}

function formatDelay(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

async function settlesWithin(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  const settled = await Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    timeout
  ]);
  clearTimeout(timer);
  return settled;
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

export class SyncRuntime {
  constructor({
    readStoredConfig = loadStoredConfig,
    writeStoredConfig = saveStoredConfig,
    mutateStoredConfig = null,
    parseConfig = loadConfig,
    createNotionSync = (config, logger) => new NotionAmsSync(config, logger),
    createBambuClient = (...args) => new BambuMqttClient(...args),
    fetchPrintTasks = fetchCloudPrintTasks,
    setRetryTimeout = setTimeout,
    clearRetryTimeout = clearTimeout,
    retryBaseMs = STARTUP_RETRY_BASE_MS,
    retryMaxMs = STARTUP_RETRY_MAX_MS,
    taskHistoryRetryBaseMs = TASK_HISTORY_RETRY_BASE_MS,
    taskHistoryRetryMaxMs = TASK_HISTORY_RETRY_MAX_MS,
    taskHistoryStopWaitMs = TASK_HISTORY_STOP_WAIT_MS,
    random = Math.random
  } = {}) {
    this.readStoredConfig = readStoredConfig;
    this.writeStoredConfig = writeStoredConfig;
    this.mutateStoredConfig = mutateStoredConfig || (
      readStoredConfig === loadStoredConfig && writeStoredConfig === saveStoredConfig
        ? updateStoredConfig
        : async (update) => {
            const existing = await this.readStoredConfig();
            const next = typeof update === "function" ? await update(existing) : { ...existing, ...update };
            return this.writeStoredConfig(next);
          }
    );
    this.parseConfig = parseConfig;
    this.createNotionSync = createNotionSync;
    this.createBambuClient = createBambuClient;
    this.fetchPrintTasks = fetchPrintTasks;
    this.setRetryTimeout = setRetryTimeout;
    this.clearRetryTimeout = clearRetryTimeout;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.taskHistoryRetryBaseMs = taskHistoryRetryBaseMs;
    this.taskHistoryRetryMaxMs = taskHistoryRetryMaxMs;
    this.taskHistoryStopWaitMs = taskHistoryStopWaitMs;
    this.random = random;
    this.logger = createLogger(process.env.LOG_LEVEL || "info");
    this.bambuClient = null;
    this.notionSync = null;
    this.taskHistoryTimer = null;
    this.taskHistorySyncRunning = false;
    this.taskHistoryRun = null;
    this.taskHistoryRunId = 0;
    this.taskHistoryRetryTimer = null;
    this.taskHistoryRetryAttempt = 0;
    this.nextTaskHistoryRetryAt = "";
    this.startupRetryTimer = null;
    this.startupRetryAttempt = 0;
    this.nextStartupRetryAt = "";
    this.startupController = null;
    this.restartRequestId = 0;
    this.restartQueue = Promise.resolve();
    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    this.maintenanceRunning = false;
    this.maintenanceRun = null;
    this.maintenanceRetryTimer = null;
    this.maintenanceRetryAttempt = 0;
    this.nextMaintenanceRetryAt = "";
    this.pendingManualSync = false;
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
    this.lastTaskHistorySyncAt = "";
    this.lastTaskHistoryCount = 0;
    this.lastTaskHistoryCheckpointAt = "";
    this.enabledSyncs = { ams: false, printHistory: false };
  }

  restart({ forceTaskHistorySync = false, startupRetry = false } = {}) {
    const requestId = ++this.restartRequestId;
    if (this.startupController && !this.startupController.signal.aborted) {
      this.startupController.abort(new Error("Sync startup was superseded"));
    }
    const run = this.restartQueue.then(() =>
      this.performRestart(requestId, { forceTaskHistorySync, startupRetry })
    );
    this.restartQueue = run.catch(() => {});
    return run;
  }

  isCurrentRestart(requestId) {
    return requestId === this.restartRequestId;
  }

  async performRestart(requestId, { forceTaskHistorySync, startupRetry }) {
    await this.stopActiveRuntime({
      resetStartupRetry: !startupRetry,
      preservePendingManualSync: startupRetry
    });
    if (!this.isCurrentRestart(requestId)) return;

    let notionSync = null;
    let bambuClient = null;
    let failedPhase = "加载配置";
    const startupController = new AbortController();
    this.startupController = startupController;

    try {
      const stored = await this.readStoredConfig();
      if (!this.isCurrentRestart(requestId)) return;

      this.enabledSyncs = syncFlagsFromStored(stored);
      if (!this.enabledSyncs.ams && !this.enabledSyncs.printHistory) {
        this.cancelStartupRetry();
        this.lastError = "";
        this.logger.info("All sync features are disabled; waiting for the user to enable AMS or print history sync");
        return;
      }

      this.starting = true;
      this.startupPhase = "加载配置";
      if (!startupRetry) this.lastError = "";

      const config = this.parseConfig({ ...process.env, ...stored });
      const notionConfig = {
        ...config.notion,
        dryRun: config.dryRun,
        printerName: config.bambu.printerName,
        printerSerial: config.bambu.printerSerial
      };

      this.logger = createLogger(config.logLevel);
      notionSync = this.createNotionSync(notionConfig, this.logger);
      this.startupPhase = "初始化 Notion";
      failedPhase = this.startupPhase;
      await awaitWithSignal(notionSync.init({
        deferMaintenance: true,
        enableAmsSync: config.notion.amsSyncEnabled,
        enablePrintTaskSync: config.notion.printTaskHistorySyncOnStart,
        signal: startupController.signal
      }), startupController.signal);
      if (!this.isCurrentRestart(requestId)) return;

      if (config.notion.amsSyncEnabled) {
        this.startupPhase = "连接打印机";
        failedPhase = this.startupPhase;
        bambuClient = this.createBambuClient(
          config.bambu,
          this.logger,
          async (trays, { signal } = {}) => {
            await notionSync.syncTrays(trays, { signal });
            if (this.isCurrentRestart(requestId) && this.notionSync === notionSync) {
              this.lastSyncAt = new Date().toISOString();
              this.lastTrayCount = trays.length;
            }
          },
          config.notion.printTaskHistorySyncOnStart
            ? (printState, { signal } = {}) => notionSync.syncPrinterStatus(printState, { signal })
            : null,
          () => this.flushPendingManualSync()
        );
        bambuClient.start();
      }
      if (!this.isCurrentRestart(requestId)) {
        bambuClient?.stop();
        return;
      }

      this.notionSync = notionSync;
      this.bambuClient = bambuClient;
      this.running = true;
      this.starting = false;
      this.startupPhase = "";
      this.lastError = "";
      this.cancelStartupRetry();
      const forcePendingHistorySync = this.pendingManualSync && config.notion.printTaskHistorySyncOnStart;
      if (!config.notion.amsSyncEnabled) this.pendingManualSync = false;
      this.runStartupMaintenance().catch((error) => {
        this.logger.error("Startup maintenance failed:", errorLogDetails(error));
      });
      this.syncPrintTaskHistory(config, {
        ignoreCooldown: forceTaskHistorySync || forcePendingHistorySync
      }).catch((error) => {
        this.logger.error("Print task history sync failed:", errorLogDetails(error));
      });
      this.schedulePrintTaskHistorySync(config);
    } catch (error) {
      bambuClient?.stop();
      if (!this.isCurrentRestart(requestId)) return;

      this.bambuClient = null;
      this.notionSync = null;
      this.running = false;
      this.starting = false;
      this.startupPhase = "";
      this.lastError = errorMessage(error);
      const details = startupErrorDetails(error) || this.lastError;
      this.logger.debug("Sync service startup failure details:", errorLogDetails(error) || details);

      if (isSetupError(error)) {
        this.cancelStartupRetry();
        this.pendingManualSync = false;
        this.logger.warn(`Sync service waiting for setup during ${failedPhase}:`, details);
      } else if (isRetryableStartupError(error)) {
        this.scheduleStartupRetry({ forceTaskHistorySync, errorDetails: details, failedPhase });
      } else {
        this.cancelStartupRetry();
        this.pendingManualSync = false;
        this.logger.error(`Sync service not started during ${failedPhase}:`, details);
      }
    } finally {
      if (this.startupController === startupController) this.startupController = null;
    }
  }

  scheduleStartupRetry({
    forceTaskHistorySync = false,
    errorDetails = this.lastError,
    failedPhase = "初始化"
  } = {}) {
    this.cancelStartupRetry({ resetAttempt: false });
    const attempt = ++this.startupRetryAttempt;
    const delay = startupRetryDelay(attempt, {
      baseMs: this.retryBaseMs,
      maxMs: this.retryMaxMs,
      random: this.random
    });
    this.nextStartupRetryAt = new Date(Date.now() + delay).toISOString();

    let timer = null;
    timer = this.setRetryTimeout(() => {
      if (this.startupRetryTimer !== timer) return undefined;
      this.startupRetryTimer = null;
      this.nextStartupRetryAt = "";
      return this.restart({ forceTaskHistorySync, startupRetry: true }).catch((error) => {
        this.logger.error("Unexpected startup retry failure:", errorLogDetails(error));
      });
    }, delay);
    this.startupRetryTimer = timer;
    this.logger.warn(
      `Sync service startup failed during ${failedPhase}: ${errorDetails}. Retrying in ${formatDelay(delay)} ` +
      `(attempt ${attempt}, at ${this.nextStartupRetryAt})`
    );
  }

  cancelStartupRetry({ resetAttempt = true } = {}) {
    if (this.startupRetryTimer != null) this.clearRetryTimeout(this.startupRetryTimer);
    this.startupRetryTimer = null;
    this.nextStartupRetryAt = "";
    if (resetAttempt) this.startupRetryAttempt = 0;
  }

  scheduleTaskHistoryRetry(config, error) {
    this.cancelTaskHistoryRetry({ resetAttempt: false });
    const attempt = ++this.taskHistoryRetryAttempt;
    const delay = startupRetryDelay(attempt, {
      baseMs: this.taskHistoryRetryBaseMs,
      maxMs: this.taskHistoryRetryMaxMs,
      random: this.random
    });
    this.nextTaskHistoryRetryAt = new Date(Date.now() + delay).toISOString();

    let timer = null;
    timer = this.setRetryTimeout(() => {
      if (this.taskHistoryRetryTimer !== timer) return undefined;
      this.taskHistoryRetryTimer = null;
      this.nextTaskHistoryRetryAt = "";
      return this.syncPrintTaskHistory(config, { ignoreCooldown: true }).catch((retryError) => {
        this.logger.error("Print task history retry failed:", errorLogDetails(retryError));
      });
    }, delay);
    timer?.unref?.();
    this.taskHistoryRetryTimer = timer;
    this.logger.warn(
      `Print task history sync failed: ${startupErrorDetails(error) || String(error)}. ` +
      `Retrying in ${formatDelay(delay)} (attempt ${attempt})`
    );
  }

  cancelTaskHistoryRetry({ resetAttempt = true } = {}) {
    if (this.taskHistoryRetryTimer != null) this.clearRetryTimeout(this.taskHistoryRetryTimer);
    this.taskHistoryRetryTimer = null;
    this.nextTaskHistoryRetryAt = "";
    if (resetAttempt) this.taskHistoryRetryAttempt = 0;
  }

  runStartupMaintenance() {
    if (!this.notionSync) return Promise.resolve();
    if (this.maintenanceRun) return this.maintenanceRun.promise;

    const run = {
      notionSync: this.notionSync,
      controller: new AbortController(),
      promise: null
    };
    this.maintenanceRunning = true;
    this.maintenanceRun = run;
    run.promise = Promise.resolve().then(() => this.performStartupMaintenance(run));
    return run.promise;
  }

  async performStartupMaintenance(run) {
    try {
      await awaitWithSignal(
        run.notionSync.runStartupMaintenance({ signal: run.controller.signal }),
        run.controller.signal
      );
      if (this.maintenanceRun === run) this.cancelMaintenanceRetry();
    } catch (error) {
      if (this.maintenanceRun === run && isRetryableStartupError(error)) {
        this.scheduleMaintenanceRetry(run.notionSync, error);
      }
      throw error;
    } finally {
      if (this.maintenanceRun === run) {
        this.maintenanceRun = null;
        this.maintenanceRunning = false;
      }
    }
  }

  scheduleMaintenanceRetry(notionSync, error) {
    this.cancelMaintenanceRetry({ resetAttempt: false });
    const attempt = ++this.maintenanceRetryAttempt;
    const delay = startupRetryDelay(attempt, {
      baseMs: MAINTENANCE_RETRY_BASE_MS,
      maxMs: MAINTENANCE_RETRY_MAX_MS,
      random: this.random
    });
    this.nextMaintenanceRetryAt = new Date(Date.now() + delay).toISOString();
    let timer = null;
    timer = this.setRetryTimeout(() => {
      if (this.maintenanceRetryTimer !== timer) return undefined;
      this.maintenanceRetryTimer = null;
      this.nextMaintenanceRetryAt = "";
      if (this.notionSync !== notionSync) return undefined;
      return this.runStartupMaintenance().catch((retryError) => {
        this.logger.error("Startup maintenance retry failed:", errorLogDetails(retryError));
      });
    }, delay);
    timer?.unref?.();
    this.maintenanceRetryTimer = timer;
    this.logger.warn(
      `Startup maintenance request failed: ${startupErrorDetails(error) || String(error)}. ` +
      `Retrying in ${formatDelay(delay)} (attempt ${attempt})`
    );
  }

  cancelMaintenanceRetry({ resetAttempt = true } = {}) {
    if (this.maintenanceRetryTimer != null) this.clearRetryTimeout(this.maintenanceRetryTimer);
    this.maintenanceRetryTimer = null;
    this.nextMaintenanceRetryAt = "";
    if (resetAttempt) this.maintenanceRetryAttempt = 0;
  }

  flushPendingManualSync() {
    if (!this.pendingManualSync) return;
    this.pendingManualSync = false;
    const ok = this.bambuClient?.requestManualSync();
    if (!ok) this.pendingManualSync = true;
  }

  async stopActiveRuntime({ resetStartupRetry = true, preservePendingManualSync = false } = {}) {
    if (this.startupController && !this.startupController.signal.aborted) {
      this.startupController.abort(new Error("Sync runtime stopped"));
    }
    this.startupController = null;
    this.cancelStartupRetry({ resetAttempt: resetStartupRetry });
    this.cancelTaskHistoryRetry();
    this.cancelMaintenanceRetry();
    clearInterval(this.taskHistoryTimer);
    this.taskHistoryTimer = null;
    this.bambuClient?.stop();
    this.bambuClient = null;
    const maintenanceRun = this.maintenanceRun;
    if (maintenanceRun && !maintenanceRun.controller.signal.aborted) {
      maintenanceRun.controller.abort(new Error("Sync runtime stopped"));
    }
    this.maintenanceRun = null;
    this.maintenanceRunning = false;
    this.notionSync = null;

    const historyRun = this.taskHistoryRun;
    if (historyRun) {
      historyRun.controller.abort(new Error("Sync runtime stopped"));
      const stopped = await settlesWithin(historyRun.promise, this.taskHistoryStopWaitMs);
      if (!stopped) {
        this.logger.warn("Print task history request did not stop promptly; detaching the old runtime safely");
      }
    }
    if (this.taskHistoryRun === historyRun) this.taskHistoryRun = null;
    this.taskHistorySyncRunning = false;

    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    if (!preservePendingManualSync) this.pendingManualSync = false;
  }

  async stop() {
    this.restartRequestId += 1;
    await this.stopActiveRuntime();
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
    if (this.starting || this.startupRetryTimer) {
      this.pendingManualSync = true;
      return {
        requested: false,
        pending: true,
        message: this.startupRetryTimer
          ? "同步服务正在等待网络恢复，恢复后会自动执行这次同步。"
          : "同步服务正在启动，连接打印机后会自动执行这次同步。"
      };
    }

    const stored = await this.readStoredConfig();
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
      const config = this.parseConfig({ ...process.env, ...stored });
      this.syncPrintTaskHistory(config, { ignoreCooldown: true }).catch((error) => {
        this.logger.error("Manual print task history sync failed:", errorLogDetails(error));
      });
      messages.push("已开始同步打印历史。");
    }

    return { requested: !pending, pending, message: messages.join(" ") };
  }

  status() {
    return {
      running: this.running,
      starting: this.starting,
      retrying: this.startupRetryTimer != null,
      startupPhase: this.startupPhase,
      startupRetryAttempt: this.startupRetryAttempt,
      nextStartupRetryAt: this.nextStartupRetryAt,
      taskHistoryRetrying: this.taskHistoryRetryTimer != null,
      taskHistoryRetryAttempt: this.taskHistoryRetryAttempt,
      nextTaskHistoryRetryAt: this.nextTaskHistoryRetryAt,
      maintenanceRunning: this.maintenanceRunning,
      maintenanceRetrying: this.maintenanceRetryTimer != null,
      maintenanceRetryAttempt: this.maintenanceRetryAttempt,
      nextMaintenanceRetryAt: this.nextMaintenanceRetryAt,
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

  async refreshTaskHistoryTotalCount(notionSync = this.notionSync, run = null) {
    if (!notionSync) return this.lastTaskHistoryCount;
    try {
      const total = await notionSync.countPrintTaskPages();
      if (!run || this.taskHistoryRun === run) this.lastTaskHistoryCount = total;
      return total;
    } catch (error) {
      this.logger.warn(`Cannot count Notion print task history: ${errorMessage(error)}`);
      return this.lastTaskHistoryCount;
    }
  }

  syncPrintTaskHistory(config, { ignoreCooldown = false } = {}) {
    if (!config.notion.printTaskHistorySyncOnStart || !config.bambu.cloud?.accessToken || !this.notionSync) {
      return Promise.resolve();
    }
    if (this.taskHistoryRun) {
      this.logger.info("Skipping print task history sync; previous sync is still running");
      return this.taskHistoryRun.promise;
    }

    const run = {
      id: ++this.taskHistoryRunId,
      controller: new AbortController(),
      notionSync: this.notionSync,
      promise: null
    };
    this.taskHistorySyncRunning = true;
    this.taskHistoryRun = run;
    run.promise = Promise.resolve().then(() => this.runPrintTaskHistorySync(config, { ignoreCooldown }, run));
    return run.promise;
  }

  assertTaskHistoryRunCurrent(run) {
    run.controller.signal.throwIfAborted();
    if (this.taskHistoryRun !== run) {
      const error = new Error("Print task history run was superseded");
      error.code = "TASK_HISTORY_RUN_STALE";
      throw error;
    }
  }

  async runPrintTaskHistorySync(config, { ignoreCooldown }, run) {
    const { notionSync, controller } = run;
    try {
      const stored = await this.readStoredConfig();
      this.assertTaskHistoryRunCurrent(run);
      const now = Date.now();
      this.lastTaskHistoryCheckpointAt = stored.PRINT_TASK_HISTORY_LAST_TASK_TIME || "";
      const lastStartedAt = Date.parse(stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || "");
      const minIntervalMs = Math.max(0, config.notion.printTaskHistoryMinIntervalMs || 0);
      if (!ignoreCooldown && minIntervalMs > 0 && Number.isFinite(lastStartedAt) && now - lastStartedAt < minIntervalMs) {
        const nextAt = new Date(lastStartedAt + minIntervalMs).toISOString();
        this.lastTaskHistorySyncAt = stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || this.lastTaskHistorySyncAt;
        await this.refreshTaskHistoryTotalCount(notionSync, run);
        this.logger.info(`Skipping print task history sync; next allowed at ${nextAt}`);
        return;
      }

      const startedAt = new Date(now).toISOString();
      this.cancelTaskHistoryRetry({ resetAttempt: false });
      const checkpoint = stored.PRINT_TASK_HISTORY_LAST_TASK_TIME || "";
      const sinceTime = taskHistoryOverlapStart(checkpoint);
      if (checkpoint && sinceTime) {
        this.logger.info(`Checking Bambu cloud print task history since ${sinceTime} with 2-day overlap`);
      }

      const tasks = await this.fetchPrintTasks({
        cloud: config.bambu.cloud,
        printerSerial: config.bambu.printerSerial,
        limit: config.notion.printTaskHistoryLimit,
        pageSize: config.notion.printTaskHistoryPageSize,
        sinceTime,
        logger: this.logger,
        signal: controller.signal
      });
      this.assertTaskHistoryRunCurrent(run);
      if (tasks.length === 0) {
        this.logger.info("No new Bambu cloud print task(s) to sync");
      }

      const result = tasks.length === 0
        ? { synced: 0, changed: 0, unchanged: 0 }
        : await notionSync.syncCloudPrintTasks(tasks, {
            signal: controller.signal,
            onTaskSynced: async (_record, { lastTaskTime }) => {
              this.assertTaskHistoryRunCurrent(run);
              if (config.dryRun || !lastTaskTime) return;
              let nextTaskTime = "";
              await this.mutateStoredConfig((latest) => {
                this.assertTaskHistoryRunCurrent(run);
                const currentMs = Date.parse(latest.PRINT_TASK_HISTORY_LAST_TASK_TIME || "");
                const nextMs = Date.parse(lastTaskTime);
                if (!Number.isFinite(nextMs) || (Number.isFinite(currentMs) && nextMs <= currentMs)) {
                  return latest;
                }
                nextTaskTime = new Date(nextMs).toISOString();
                return { ...latest, PRINT_TASK_HISTORY_LAST_TASK_TIME: nextTaskTime };
              });
              this.assertTaskHistoryRunCurrent(run);
              if (nextTaskTime) this.lastTaskHistoryCheckpointAt = nextTaskTime;
            }
          });
      this.assertTaskHistoryRunCurrent(run);

      await this.mutateStoredConfig((latest) => {
        this.assertTaskHistoryRunCurrent(run);
        return { ...latest, PRINT_TASK_HISTORY_LAST_SYNC_AT: startedAt };
      });
      this.assertTaskHistoryRunCurrent(run);
      this.lastTaskHistorySyncAt = startedAt;
      await this.refreshTaskHistoryTotalCount(notionSync, run);
      this.assertTaskHistoryRunCurrent(run);
      this.cancelTaskHistoryRetry();
      this.logger.info(
        `Print task history sync finished: ${result.synced} checked, ${result.changed} changed, ${result.unchanged} unchanged, ${this.lastTaskHistoryCount} total, checkpoint ${this.lastTaskHistoryCheckpointAt || "unchanged"}`
      );
    } catch (error) {
      if (!controller.signal.aborted && this.taskHistoryRun === run) {
        this.scheduleTaskHistoryRetry(config, error);
      }
      throw error;
    } finally {
      if (this.taskHistoryRun === run) {
        this.taskHistoryRun = null;
        this.taskHistorySyncRunning = false;
      }
    }
  }

  schedulePrintTaskHistorySync(config) {
    clearInterval(this.taskHistoryTimer);
    this.taskHistoryTimer = null;
    if (!config.notion.printTaskHistorySyncOnStart || !config.bambu.cloud?.accessToken || !this.notionSync) return;

    const intervalMs = Math.max(60000, config.notion.printTaskHistoryMinIntervalMs || 300000);
    this.taskHistoryTimer = setInterval(() => {
      this.syncPrintTaskHistory(config).catch((error) => {
        this.logger.error("Scheduled print task history sync failed:", errorLogDetails(error));
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
    if (client.destroyed || client.writableEnded) {
      uiReloadClients.delete(client);
      continue;
    }
    try {
      client.write("data: reload\n\n");
    } catch (error) {
      uiReloadClients.delete(client);
      client.destroy(error);
    }
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
    console.warn(`Admin UI reload watcher failed: ${errorMessage(error)}`);
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
  if (body.token.devices?.length === 1) {
    await updateStoredConfig((latest) => {
      if (latest.BAMBU_PRINTER_SERIAL) return latest;
      return {
        ...latest,
        BAMBU_PRINTER_SERIAL: body.token.devices[0].dev_id,
        BAMBU_PRINTER_NAME: body.token.devices[0].name || latest.BAMBU_PRINTER_NAME
      };
    });
  }
  await runtime.restart();
}

async function resetBambuLogin() {
  const existing = await loadStoredConfig();
  const tokenFile = resolve(existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
  await runtime.reset();
  await removeIfExists(tokenFile);
  await updateStoredConfig({
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
      let existing;
      let next;
      await updateStoredConfig((latest) => {
        existing = latest;
        next = mergeConfig(latest, body);
        return next;
      });
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
      await updateStoredConfig({
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
    sendJson(res, 400, { error: errorMessage(error) });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
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
  req.on("error", () => {});
  res.on("error", () => {});
  handleRequest(req, res).catch((error) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendJson(res, 500, { error: errorMessage(error) });
  });
});
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;

export function startAdminServer() {
  server.listen(PORT, HOST, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : PORT;
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST.includes(":") ? `[${HOST}]` : HOST;
    console.log(`Admin UI: http://${displayHost}:${listeningPort}`);
    startUiReloadWatcher();
    runtime.restart().catch((error) => {
      console.error("Unexpected sync runtime startup failure:", errorLogDetails(error));
    });
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    uiReloadWatcher?.close();
    runtime.stop()
      .catch((error) => {
        console.error("Sync runtime shutdown failed:", errorLogDetails(error));
      })
      .finally(() => {
        server.close(() => process.exit(0));
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

const entryFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryFile) startAdminServer();
