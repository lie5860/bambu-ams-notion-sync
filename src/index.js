import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

async function main() {
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
  await notionSync.init();

  const bambuClient = new BambuMqttClient(
    rawConfig.bambu,
    logger,
    (trays) => notionSync.syncTrays(trays),
    (printState) => notionSync.syncPrinterStatus(printState)
  );
  bambuClient.start();

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
    bambuClient.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
