import { BambuMqttClient } from "./bambu.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const durationMs = Number(process.env.DEBUG_BAMBU_DURATION_MS || 30000);

logger.info(
  `Debugging Bambu ${config.bambu.connectionMode} MQTT for ${config.bambu.printerSerial}; waiting ${durationMs}ms`
);

const client = new BambuMqttClient(config.bambu, logger, async (trays) => {
  logger.info(`Received ${trays.length} AMS tray(s):`);
  for (const tray of trays) {
    logger.info(
      `${tray.slotLabel} uid=${tray.uid} material=${tray.material || "-"} remain=${tray.remainPercent ?? "?"}% grams=${tray.remainGrams ?? "?"} color=${tray.color || "-"}`
    );
  }
});

client.start();

setTimeout(() => {
  logger.info("Debug window ended");
  client.stop();
  process.exit(0);
}, durationMs);
