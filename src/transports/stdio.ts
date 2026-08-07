import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AtomService } from "../atom-service.js";
import type { Database } from "../db.js";
import type { MaintenanceService } from "../maintenance.js";
import type { SmartMemoryService } from "../smart-memory.js";
import { createMcpServer } from "../mcp-server.js";
import { logger } from "../telemetry.js";

export async function serveStdio(atoms: AtomService, database: Database, maintenance?: MaintenanceService, smartMemory?: SmartMemoryService): Promise<void> {
  const server = createMcpServer(atoms, database, maintenance, smartMemory);
  const transport = new StdioServerTransport();
  process.on("SIGINT", async () => {
    maintenance?.stop();
    await server.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.exit(0);
  });
  await server.connect(transport);
  logger.info("Foundation MCP is running over stdio");
}
