import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60 * 1000;
const PERMANENT_RETRY_MS = 5 * 60 * 1000;

const PERMANENT_ERROR_CODES = new Set([
  "invalid_json",
  "invalid_request",
  "invalid_request_url",
  "notionhq_client_invalid_path_parameter",
  "object_not_found",
  "restricted_resource",
  "unauthorized",
  "validation_error"
]);

const PERMANENT_TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

function envEnabled(name) {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] || "").toLowerCase());
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

function errorDetails(error) {
  if (!error || typeof error !== "object") return String(error);
  return errorChain(error)
    .map((item) => {
      const message = String(item.message || "").trim();
      const code = String(item.code || "").trim();
      if (!message) return code;
      return code && !message.includes(code) ? `${message} (${code})` : message;
    })
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("; caused by: ") || String(error);
}

export function isPermanentCliError(error) {
  return errorChain(error).some((item) => {
    const status = Number(item.status || item.statusCode);
    if ([400, 401, 403, 404, 405, 410, 422].includes(status)) return true;

    const code = String(item.code || "");
    if (PERMANENT_ERROR_CODES.has(code) || PERMANENT_TLS_ERROR_CODES.has(code)) return true;

    const message = String(item.message || "");
    return (
      message.startsWith("Missing required env:") ||
      message.startsWith("Cannot read Bambu cloud token file") ||
      message.includes(" must be an integer") ||
      message.includes(" must contain a 32-character Notion id") ||
      message === "BAMBU_CONNECTION_MODE must be local or cloud"
    );
  });
}

export function cliRetryDelay(attempt, {
  baseMs = RETRY_BASE_MS,
  maxMs = RETRY_MAX_MS,
  random = Math.random
} = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(Math.min(maxMs, exponential * jitter)));
}

export function handledAsyncCallback(callback) {
  return (...args) => {
    const operation = Promise.resolve().then(() => callback(...args));
    operation.catch(() => {});
    return operation;
  };
}

function formatDelay(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export class CliSyncSupervisor {
  constructor({
    featuresEnabled = () => envEnabled("AMS_SYNC_ENABLED") || envEnabled("PRINT_TASK_HISTORY_SYNC_ON_START"),
    readConfig = loadConfig,
    createRuntimeLogger = createLogger,
    createNotionSync = (config, logger) => new NotionAmsSync(config, logger),
    createBambuClient = (...args) => new BambuMqttClient(...args),
    fetchPrintTasks = fetchCloudPrintTasks,
    setRetryTimeout = setTimeout,
    clearRetryTimeout = clearTimeout,
    retryBaseMs = RETRY_BASE_MS,
    retryMaxMs = RETRY_MAX_MS,
    permanentRetryMs = PERMANENT_RETRY_MS,
    random = Math.random
  } = {}) {
    this.featuresEnabled = featuresEnabled;
    this.readConfig = readConfig;
    this.createRuntimeLogger = createRuntimeLogger;
    this.createNotionSync = createNotionSync;
    this.createBambuClient = createBambuClient;
    this.fetchPrintTasks = fetchPrintTasks;
    this.setRetryTimeout = setRetryTimeout;
    this.clearRetryTimeout = clearRetryTimeout;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.permanentRetryMs = permanentRetryMs;
    this.random = random;
    this.logger = this.createRuntimeLogger(process.env.LOG_LEVEL || "info");
    this.bambuClient = null;
    this.retryWait = null;
    this.abortController = new AbortController();
    this.stopping = false;
    this.stopPromise = new Promise((resolveStop) => {
      this.resolveStop = resolveStop;
    });
  }

  async run() {
    let transientAttempt = 0;

    while (!this.stopping) {
      let bambuClient = null;
      try {
        if (!this.featuresEnabled()) {
          this.logger.info(
            "No sync features enabled; set AMS_SYNC_ENABLED=true or PRINT_TASK_HISTORY_SYNC_ON_START=true to start syncing."
          );
          return;
        }

        const rawConfig = this.readConfig();
        this.logger = this.createRuntimeLogger(rawConfig.logLevel);
        const notionConfig = {
          ...rawConfig.notion,
          dryRun: rawConfig.dryRun,
          printerName: rawConfig.bambu.printerName,
          printerSerial: rawConfig.bambu.printerSerial
        };

        this.logger.info(`Starting bambu-ams-notion-sync (${rawConfig.dryRun ? "dry-run" : "write mode"})`);
        const notionSync = this.createNotionSync(notionConfig, this.logger);
        const initialized = await this.waitUnlessStopped(notionSync.init({
          enableAmsSync: rawConfig.notion.amsSyncEnabled,
          enablePrintTaskSync: rawConfig.notion.printTaskHistorySyncOnStart,
          signal: this.abortController.signal
        }));
        if (!initialized || this.stopping) return;

        let reportRuntimeFailure;
        const runtimeFailure = new Promise((_, rejectFailure) => {
          reportRuntimeFailure = rejectFailure;
        });
        runtimeFailure.catch(() => {});

        if (rawConfig.notion.amsSyncEnabled) {
          bambuClient = this.createBambuClient(
            rawConfig.bambu,
            this.logger,
            handledAsyncCallback((trays, { signal } = {}) => notionSync.syncTrays(trays, { signal })),
            rawConfig.notion.printTaskHistorySyncOnStart
              ? handledAsyncCallback((printState, { signal } = {}) => notionSync.syncPrinterStatus(printState, { signal }))
              : null
          );
          this.bambuClient = bambuClient;
          bambuClient.start();
        }
        if (this.stopping) {
          this.stopBambuClient(bambuClient);
          return;
        }

        transientAttempt = 0;
        const historySync = this.syncPrintHistoryUntilSuccess(rawConfig, notionSync);

        if (!rawConfig.notion.amsSyncEnabled) {
          await this.waitUnlessStopped(historySync);
          return;
        }

        historySync.catch(reportRuntimeFailure);
        await Promise.race([this.stopPromise, runtimeFailure]);
        return;
      } catch (error) {
        this.stopBambuClient(bambuClient);
        if (this.stopping) return;

        const permanent = isPermanentCliError(error);
        if (permanent) transientAttempt = 0;
        else transientAttempt += 1;
        const delay = permanent
          ? this.permanentRetryMs
          : cliRetryDelay(transientAttempt, {
              baseMs: this.retryBaseMs,
              maxMs: this.retryMaxMs,
              random: this.random
            });
        const kind = permanent ? "configuration or authorization failure" : "transient startup failure";
        this.logger.error(
          `Sync ${kind}: ${errorDetails(error)}. Retrying in ${formatDelay(delay)}; the process will remain running.`
        );
        if (!(await this.waitForRetry(delay))) return;
      }
    }
  }

  async syncPrintHistoryUntilSuccess(rawConfig, notionSync) {
    if (
      !rawConfig.notion.printTaskHistorySyncOnStart ||
      !rawConfig.bambu.cloud?.accessToken
    ) {
      return;
    }

    let transientAttempt = 0;
    while (!this.stopping) {
      try {
        const tasks = await this.fetchPrintTasks({
          cloud: rawConfig.bambu.cloud,
          printerSerial: rawConfig.bambu.printerSerial,
          limit: rawConfig.notion.printTaskHistoryLimit,
          pageSize: rawConfig.notion.printTaskHistoryPageSize,
          logger: this.logger,
          signal: this.abortController.signal
        });
        if (this.stopping) return;
        await notionSync.syncCloudPrintTasks(tasks, { signal: this.abortController.signal });
        return;
      } catch (error) {
        if (this.stopping) return;

        const permanent = isPermanentCliError(error);
        if (permanent) throw error;

        transientAttempt += 1;
        const delay = cliRetryDelay(transientAttempt, {
          baseMs: this.retryBaseMs,
          maxMs: this.retryMaxMs,
          random: this.random
        });
        this.logger.error(
          `Print task history sync failed: ${errorDetails(error)}. Retrying in ${formatDelay(delay)}.`
        );
        if (!(await this.waitForRetry(delay))) return;
      }
    }
  }

  waitForRetry(delay) {
    if (this.stopping) return Promise.resolve(false);

    return new Promise((resolveWait) => {
      let timer = null;
      const finish = (shouldRetry) => {
        if (this.retryWait?.timer === timer) this.retryWait = null;
        resolveWait(shouldRetry);
      };
      timer = this.setRetryTimeout(() => finish(true), delay);
      this.retryWait = { timer, finish };
    });
  }

  async waitUnlessStopped(operation) {
    const outcome = await Promise.race([
      Promise.resolve(operation).then(
        () => ({ completed: true }),
        (error) => ({ completed: true, error })
      ),
      this.stopPromise.then(() => ({ completed: false }))
    ]);
    if ("error" in outcome) throw outcome.error;
    return outcome.completed;
  }

  stopBambuClient(client = this.bambuClient) {
    if (!client) return;
    if (this.bambuClient === client) this.bambuClient = null;
    try {
      client.stop();
    } catch (error) {
      this.logger.error("Failed to stop Bambu MQTT client:", errorDetails(error));
    }
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.abortController.abort(new Error("CLI sync supervisor stopped"));
    const retryWait = this.retryWait;
    if (retryWait) {
      this.clearRetryTimeout(retryWait.timer);
      this.retryWait = null;
      retryWait.finish(false);
    }
    this.stopBambuClient();
    this.resolveStop();
  }
}

export async function main() {
  const supervisor = new CliSyncSupervisor();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    supervisor.logger.info("Shutting down...");
    supervisor.stop();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await supervisor.run();
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    supervisor.stop();
  }
}

const entryFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryFile) {
  main().catch((error) => {
    console.error("Unexpected sync supervisor failure:", errorDetails(error));
    process.exitCode = 1;
  });
}
