#!/usr/bin/env node
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { serveHTTP } from "./transports/http.js";
import { serveStdio } from "./transports/stdio.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new Database(config);
  await database.initialize();
  const embeddings = new EmbeddingService(config);
  const atoms = new AtomService(database, embeddings);

  if (config.transport === "http") {
    await serveHTTP(config, atoms, database);
  } else {
    await serveStdio(atoms, database);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
