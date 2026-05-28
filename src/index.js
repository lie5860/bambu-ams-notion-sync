import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

function envEnabled(name) {
  return ["1", "true", "yes", "y", "on"].includes(String(process.env[name] || "").toLowerCase());
}

async function main() {
  const bootstrapLogger = createLogger(process.env.LOG_LEVEL || "info");
  if (!envEnabled("AMS_SYNC_ENABLED") && !envEnabled("PRINT_TASK_HISTORY_SYNC_ON_START")) {
    bootstrapLogger.info(
      "No sync features enabled; set AMS_SYNC_ENABLED=true or PRINT_TASK_HISTORY_SYNC_ON_START=true to start syncing."
    );
    return;
  }

  const rawConfig = loadConfig();
  const logger = createLogger(rawConfig.logLevel);

  const notionConfig = {
    ...rawConfig.notion,
    dryRun: rawConfig.dryRun,
    printerName: rawConfig.bambu.printerName,
    printerSerial: rawConfig.bambu.printerSerial
  };

  logger.info(`Starting bambu-ams-notion-sync (${rawConfig.dryRun ? "dry-run" : "write mode"})`);

  const notionSync = new NotionAmsSync(notionConfig, logger);
  await notionSync.init({
    enableAmsSync: rawConfig.notion.amsSyncEnabled,
    enablePrintTaskSync: rawConfig.notion.printTaskHistorySyncOnStart
  });

  let bambuClient = null;
  if (rawConfig.notion.amsSyncEnabled) {
    bambuClient = new BambuMqttClient(
      rawConfig.bambu,
      logger,
      (trays) => notionSync.syncTrays(trays),
      rawConfig.notion.printTaskHistorySyncOnStart ? (printState) => notionSync.syncPrinterStatus(printState) : null
    );
    bambuClient.start();
  }

  if (rawConfig.notion.printTaskHistorySyncOnStart && rawConfig.bambu.cloud?.accessToken) {
    fetchCloudPrintTasks({
      cloud: rawConfig.bambu.cloud,
      printerSerial: rawConfig.bambu.printerSerial,
      limit: rawConfig.notion.printTaskHistoryLimit,
      pageSize: rawConfig.notion.printTaskHistoryPageSize,
      logger
    })
      .then((tasks) => notionSync.syncCloudPrintTasks(tasks))
      .catch((error) => logger.error("Print task history sync failed:", error.stack || error.message));
  }

  const shutdown = () => {
    logger.info("Shutting down...");
    bambuClient?.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
