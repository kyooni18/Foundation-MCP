import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AtomService } from "../atom-service.js";
import { allNamespacesAllowed, assertNamespacesAllowed, authorizeToolNamespaces } from "../authorization.js";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { MaintenanceService } from "../maintenance.js";
import type { SmartMemoryService } from "../smart-memory.js";
import { createMcpServer } from "../mcp-server.js";
import { createOAuthRouter, OAuthService } from "../oauth.js";
import { FixedWindowRateLimiter } from "../rate-limit.js";
import { logger, metrics } from "../telemetry.js";
import { normalizeNamespace, secureTokenEqual } from "../utils.js";

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

const READ_ONLY_TOOLS = new Set([
  "foundation_health",
  "foundation_diagnostics",
  "foundation_maintenance_status",
  "atom_get",
  "atom_search",
  "atom_find_similar",
  "atom_context",
  "atom_list",
  "atom_neighbors",
  "atom_history",
  "atom_stats",
  "atom_lifecycle_suggestions",
  "memory_recall"
]);

function hostOnly(value: string | undefined): string {
  if (!value) return "";
  const first = value.split(",", 1)[0]!.trim();
  if (first.startsWith("[")) return first.slice(1, first.indexOf("]"));
  return first.split(":", 1)[0]!.toLowerCase();
}

function requestHosts(req: Request): string[] {
  // Do not trust X-Forwarded-Host from arbitrary clients. A reverse proxy should
  // preserve/set the ordinary Host header to the public Foundation hostname.
  return [hostOnly(req.headers.host)].filter(Boolean);
}

function clientKey(req: Request): string {
  // Deliberately use the transport peer. Forwarded IP headers are only safe
  // when the proxy trust boundary is explicitly configured outside Foundation.
  return req.socket.remoteAddress ?? "unknown";
}

function rateLimitMiddleware(limiter: FixedWindowRateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.consume(clientKey(req));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))));
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    next();
  };
}

export async function serveHTTP(
  config: Config,
  atoms: AtomService,
  database: Database,
  maintenance?: MaintenanceService,
  smartMemory?: SmartMemoryService
): Promise<void> {
  if (!config.apiKey && !config.readOnlyAPIKey && !config.oauthEnabled && !["127.0.0.1", "localhost", "::1"].includes(config.host)) {
    throw new Error("Configure OAuth or a Foundation API key when HTTP is not bound to localhost");
  }

  const app = express();
  const requestLimiter = new FixedWindowRateLimiter(config.requestRateLimitPerMinute);
  const oauthLimiter = new FixedWindowRateLimiter(config.oauthRateLimitPerMinute);
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.maxRequestBytes }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestID = typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].length <= 128
      ? req.headers["x-request-id"]
      : randomUUID();
    res.setHeader("X-Request-ID", requestID);
    const started = process.hrtime.bigint();
    logger.withRequest(requestID, () => {
      res.on("finish", () => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        metrics.increment("http_requests_total");
        metrics.observe("http_request", seconds);
        logger.info("HTTP request", { method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(seconds * 1_000) });
      });
      next();
    });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const hosts = requestHosts(req);
    if (config.allowedHosts.length && !hosts.some(host => config.allowedHosts.includes(host))) {
      logger.warn("Blocked request with untrusted Host", { hosts, allowedHosts: config.allowedHosts });
      res.status(403).json({ error: "Host is not allowed" });
      return;
    }
    next();
  });

  app.use(config.mcpPath, rateLimitMiddleware(requestLimiter));
  for (const path of ["/register", "/authorize", "/token", "/revoke"]) app.use(path, rateLimitMiddleware(oauthLimiter));

  const oauth = config.oauthEnabled ? new OAuthService(config, database) : null;
  if (oauth) app.use(createOAuthRouter(oauth));

  app.get("/live", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const readiness = async (_req: Request, res: Response) => {
    try {
      const health = await database.health();
      res.json({ ok: true, oauth: config.oauthEnabled, schemaVersion: health.schema_version });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
  app.get("/ready", readiness);
  // /health is retained as a compatibility alias for readiness.
  app.get("/health", readiness);

  if (config.metricsEnabled) {
    app.get(config.metricsPath, (req: Request, res: Response) => {
      if (config.apiKey) {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token || !secureTokenEqual(config.apiKey, token)) {
          res.status(401).end();
          return;
        }
      }
      res.type("text/plain; version=0.0.4").send(metrics.prometheus());
    });
  }

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

    const namespacePatterns = isAdmin
      ? config.adminNamespaces
      : isReadOnlyKey
        ? config.readOnlyNamespaces
        : oauthPrincipal?.allowedNamespaces ?? ["*"];

    if (req.body?.method === "tools/call") {
      const toolName = req.body?.params?.name;
      if (typeof toolName !== "string") {
        rpcError(res, 400, -32602, "Invalid tool name");
        return;
      }
      const isReadTool = READ_ONLY_TOOLS.has(toolName);
      const requiredScope = isReadTool ? "atom:read" : "atom:write";
      const allowedByScope = isAdmin || (isReadOnlyKey ? isReadTool : Boolean(oauthPrincipal?.scopes.has(requiredScope)));
      if (!allowedByScope) {
        if (oauth) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${oauth.protectedResourceMetadataURL}"`
          );
        }
        rpcError(res, 403, -32003, `This credential requires ${requiredScope}`);
        return;
      }

      try {
        const args = req.body?.params?.arguments;
        await authorizeToolNamespaces(atoms, toolName, args && typeof args === "object" ? args : {}, namespacePatterns);
      } catch (error) {
        rpcError(res, 403, -32003, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    // The compatibility stats resource has no namespace parameter, so a
    // namespace-restricted credential must not be able to use it as a global
    // aggregate side channel. The resource URI itself remains unchanged.
    if (req.body?.method === "resources/read" && req.body?.params?.uri === "foundation://stats") {
      const canReadAtoms = isAdmin || isReadOnlyKey || Boolean(oauthPrincipal?.scopes.has("atom:read"));
      if (!canReadAtoms) {
        rpcError(res, 403, -32003, "foundation://stats requires atom:read");
        return;
      }
      if (!allNamespacesAllowed(namespacePatterns)) {
        rpcError(res, 403, -32003, "foundation://stats requires a credential authorized for all namespaces");
        return;
      }
    }

    if (req.body?.method === "prompts/get" && req.body?.params?.name === "foundation-memory-policy") {
      try {
        const namespace = typeof req.body?.params?.arguments?.namespace === "string"
          ? normalizeNamespace(req.body.params.arguments.namespace)
          : "default";
        assertNamespacesAllowed([namespace], namespacePatterns);
      } catch (error) {
        rpcError(res, 403, -32003, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    next();
  });

  app.post(config.mcpPath, async (req: Request, res: Response) => {
    const server = createMcpServer(atoms, database, maintenance, smartMemory);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP HTTP request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });

  app.get(config.mcpPath, (_req: Request, res: Response) => rpcError(res, 405, -32000, "Method not allowed; use POST for stateless MCP"));
  app.delete(config.mcpPath, (_req: Request, res: Response) => rpcError(res, 405, -32000, "Method not allowed; this server is stateless"));

  const httpServer = app.listen(config.port, config.host, () => {
    logger.info("Foundation MCP listening", { url: `http://${config.host}:${config.port}${config.mcpPath}` });
    if (oauth) logger.info("Foundation OAuth enabled", { issuer: oauth.issuer });
  });

  const shutdown = async () => {
    maintenance?.stop();
    httpServer.close();
    await database.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
