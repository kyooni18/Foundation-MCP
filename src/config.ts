import { safeIndexDimension } from "./utils.js";

export type TransportMode = "stdio" | "http";
export type EmbeddingProviderName = "openai" | "ollama" | "none";

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function choice<T extends string>(name: string, fallback: T, choices: readonly T[]): T {
  const value = (process.env[name] ?? fallback) as T;
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  return value;
}

function publicURL(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use https");
  if (parsed.pathname !== "/") throw new Error("PUBLIC_BASE_URL must be an origin without a path");
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export interface Config {
  transport: TransportMode;
  host: string;
  port: number;
  mcpPath: string;
  allowedHosts: string[];
  apiKey: string | null;
  readOnlyAPIKey: string | null;
  maxRequestBytes: number;
  databaseURL: string;
  databasePoolSize: number;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  openAIAPIKey: string | null;
  openAIBaseURL: string;
  ollamaBaseURL: string;
  autoMigrate: boolean;
  enableAudit: boolean;
  publicBaseURL: string | null;
  oauthEnabled: boolean;
  oauthLoginPassword: string | null;
  oauthAllowRegistration: boolean;
  oauthAccessTokenTTLSeconds: number;
  oauthRefreshTokenTTLSeconds: number;
}

export function loadConfig(): Config {
  const transport = choice("MCP_TRANSPORT", "stdio", ["stdio", "http"] as const);
  const embeddingProvider = choice("EMBEDDING_PROVIDER", "none", ["openai", "ollama", "none"] as const);
  const embeddingDimensions = safeIndexDimension(integer("EMBEDDING_DIMENSIONS", 1536));
  const resolvedPublicURL = publicURL(process.env.PUBLIC_BASE_URL);
  const defaultHosts = ["localhost", "127.0.0.1", "::1"];
  if (resolvedPublicURL) defaultHosts.unshift(new URL(resolvedPublicURL).hostname.toLowerCase());
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? defaultHosts.join(","))
    .split(",")
    .map((value: string) => value.trim().toLowerCase())
    .filter(Boolean);
  const oauthEnabled = boolean("OAUTH_ENABLED", false);
  const oauthLoginPassword = process.env.OAUTH_LOGIN_PASSWORD?.trim() || null;

  if (oauthEnabled && transport !== "http") throw new Error("OAUTH_ENABLED requires MCP_TRANSPORT=http");
  if (oauthEnabled && !resolvedPublicURL) throw new Error("OAUTH_ENABLED requires PUBLIC_BASE_URL=https://...");
  if (oauthEnabled && !oauthLoginPassword) throw new Error("OAUTH_ENABLED requires OAUTH_LOGIN_PASSWORD");
  const oauthAccessTokenTTLSeconds = integer("OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3_600);
  const oauthRefreshTokenTTLSeconds = integer("OAUTH_REFRESH_TOKEN_TTL_SECONDS", 2_592_000);
  if (oauthAccessTokenTTLSeconds < 60) throw new Error("OAUTH_ACCESS_TOKEN_TTL_SECONDS must be at least 60");
  if (oauthRefreshTokenTTLSeconds < oauthAccessTokenTTLSeconds) {
    throw new Error("OAUTH_REFRESH_TOKEN_TTL_SECONDS must be at least the access token TTL");
  }

  return {
    transport,
    host: process.env.HOST ?? (transport === "http" ? "0.0.0.0" : "127.0.0.1"),
    port: integer("PORT", 8787),
    mcpPath: process.env.MCP_PATH ?? "/mcp",
    allowedHosts,
    apiKey: (process.env.FOUNDATION_ADMIN_KEY ?? process.env.FOUNDATION_API_KEY)?.trim() || null,
    readOnlyAPIKey: process.env.FOUNDATION_READ_ONLY_KEY?.trim() || null,
    maxRequestBytes: integer("MAX_REQUEST_BYTES", 1_048_576),
    databaseURL: process.env.DATABASE_URL ?? "postgresql://foundation:foundation@127.0.0.1:5432/foundation",
    databasePoolSize: integer("DATABASE_POOL_SIZE", 10),
    embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL ?? (embeddingProvider === "ollama" ? "nomic-embed-text" : "text-embedding-3-small"),
    embeddingDimensions,
    openAIAPIKey: process.env.OPENAI_API_KEY?.trim() || null,
    openAIBaseURL: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    ollamaBaseURL: (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    autoMigrate: boolean("AUTO_MIGRATE", true),
    enableAudit: boolean("ENABLE_AUDIT", true),
    publicBaseURL: resolvedPublicURL,
    oauthEnabled,
    oauthLoginPassword,
    oauthAllowRegistration: boolean("OAUTH_ALLOW_DYNAMIC_REGISTRATION", true),
    oauthAccessTokenTTLSeconds,
    oauthRefreshTokenTTLSeconds
  };
}
