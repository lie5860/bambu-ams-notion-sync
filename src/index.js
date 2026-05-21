import { BambuMqttClient } from "./bambu.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

async function main() {
  const rawConfig = loadConfig();
  const logger = createLogger(rawConfig.logLevel);

  const notionConfig = {
    ...rawConfig.notion,
    dryRun: rawConfig.dryRun,
    printerName: rawConfig.bambu.printerName
  };

  logger.info(`Starting bambu-ams-notion-sync (${rawConfig.dryRun ? "dry-run" : "write mode"})`);

  const notionSync = new NotionAmsSync(notionConfig, logger);
  await notionSync.init();

  const bambuClient = new BambuMqttClient(rawConfig.bambu, logger, (trays) =>
    notionSync.syncTrays(trays)
  );
  bambuClient.start();

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
