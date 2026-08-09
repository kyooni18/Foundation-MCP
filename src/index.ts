#!/usr/bin/env node
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { MaintenanceService } from "./maintenance.js";
import { SlotAwareSmartMemoryService } from "./smart-memory-slots.js";
import { configureTelemetry, logger } from "./telemetry.js";
import { serveHTTP } from "./transports/http.js";
import { serveStdio } from "./transports/stdio.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureTelemetry({ format: config.logFormat, level: config.logLevel });
  const database = new Database(config);
  await database.initialize();
  const embeddings = new EmbeddingService(config);
  const atoms = new AtomService(database, embeddings);
  const maintenance = new MaintenanceService(config, atoms, database);
  const smartMemory = new SlotAwareSmartMemoryService(config, atoms);
  maintenance.start();

  if (config.transport === "http") {
    await serveHTTP(config, atoms, database, maintenance, smartMemory);
  } else {
    await serveStdio(atoms, database, maintenance, smartMemory);
  }
}

main().catch(error => {
  logger.error("Foundation startup failed", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});
