import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AtomService } from "../atom-service.js";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { createMcpServer } from "../mcp-server.js";
import { createOAuthRouter, OAuthService } from "../oauth.js";
import { secureTokenEqual } from "../utils.js";

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

const READ_ONLY_TOOLS = new Set([
  "foundation_health",
  "atom_get",
  "atom_search",
  "atom_find_similar",
  "atom_context",
  "atom_list",
  "atom_neighbors",
  "atom_history",
  "atom_stats"
]);

function hostOnly(value: string | undefined): string {
  if (!value) return "";
  const first = value.split(",", 1)[0]!.trim();
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"));
  return first.split(":", 1)[0]!.toLowerCase();
}

function requestHosts(req: Request): string[] {
  const values = [
    typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : undefined,
    req.headers.host
  ];
  return [...new Set(values.map(hostOnly).filter(Boolean))];
}

export async function serveHTTP(config: Config, atoms: AtomService, database: Database): Promise<void> {
  if (!config.apiKey && !config.readOnlyAPIKey && !config.oauthEnabled && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    throw new Error("Configure OAuth or a Foundation API key when HTTP is not bound to localhost");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxRequestBytes }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const hosts = requestHosts(req);
    if (config.allowedHosts.length && !hosts.some(host => config.allowedHosts.includes(host))) {
      console.warn("Blocked request with untrusted Host", { hosts, allowedHosts: config.allowedHosts });
      res.status(403).json({ error: "Host is not allowed" });
      return;
    }
    next();
  });

  const oauth = config.oauthEnabled ? new OAuthService(config, database) : null;
  if (oauth) app.use(createOAuthRouter(oauth));

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await database.query("SELECT 1");
      res.json({ ok: true, oauth: config.oauthEnabled });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use(config.mcpPath, async (req: Request, res: Response, next: NextFunction) => {
    if (!config.apiKey && !config.readOnlyAPIKey && !oauth) return next();

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const isAdmin = Boolean(token && config.apiKey && secureTokenEqual(config.apiKey, token));
    const isReadOnlyKey = Boolean(token && config.readOnlyAPIKey && secureTokenEqual(config.readOnlyAPIKey, token));
    const oauthPrincipal = !isAdmin && !isReadOnlyKey && oauth ? await oauth.validateAccessToken(token) : null;

    if (!isAdmin && !isReadOnlyKey && !oauthPrincipal) {
      const challenge = oauth
        ? `Bearer realm="foundation", resource_metadata="${oauth.protectedResourceMetadataURL}"`
        : "Bearer";
      res.setHeader("WWW-Authenticate", challenge);
      rpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    if (req.body?.method === "tools/call" && !isAdmin) {
      const toolName = req.body?.params?.name;
      const isReadTool = typeof toolName === "string" && READ_ONLY_TOOLS.has(toolName);
      const requiredScope = isReadTool ? "atom:read" : "atom:write";
      const allowed = isReadOnlyKey ? isReadTool : Boolean(oauthPrincipal?.scopes.has(requiredScope));
      if (!allowed) {
        if (oauth) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${oauth.protectedResourceMetadataURL}"`
          );
        }
        rpcError(res, 403, -32003, `This credential requires ${requiredScope}`);
        return;
      }
    }
    next();
  });

  app.post(config.mcpPath, async (req: Request, res: Response) => {
    const server = createMcpServer(atoms, database);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP HTTP request failed", error);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });

  app.get(config.mcpPath, (_req: Request, res: Response) => rpcError(res, 405, -32000, "Method not allowed; use POST for stateless MCP"));
  app.delete(config.mcpPath, (_req: Request, res: Response) => rpcError(res, 405, -32000, "Method not allowed; this server is stateless"));

  const httpServer = app.listen(config.port, config.host, () => {
    console.error(`Foundation MCP listening on http://${config.host}:${config.port}${config.mcpPath}`);
    if (oauth) console.error(`Foundation OAuth issuer: ${oauth.issuer}`);
  });

  const shutdown = async () => {
    httpServer.close();
    await database.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
