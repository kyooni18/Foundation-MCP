import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AtomService } from "../atom-service.js";
import type { Database } from "../db.js";
import { createMcpServer } from "../mcp-server.js";

export async function serveStdio(atoms: AtomService, database: Database): Promise<void> {
  const server = createMcpServer(atoms, database);
  const transport = new StdioServerTransport();
  process.on("SIGINT", async () => {
    await server.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    process.exit(0);
  });
  await server.connect(transport);
  console.error("Foundation MCP is running over stdio");
}
