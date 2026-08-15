import { safeIndexDimension } from "./utils.js";
import type { LogLevel } from "./telemetry.js";

export type TransportMode = "stdio" | "http";
export type EmbeddingProviderName = "openai" | "ollama" | "google" | "gemini" | "openrouter" | "none";
export type SmartModelMode = "off" | "auto" | "on";
export type McpToolProfile = "balanced" | "full";

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function numberValue(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
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

function serviceURL(name: string, fallback: string): string {
  const value = (process.env[name] ?? fallback).trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  return value;
}


function smartModelMode(name: string, fallback: SmartModelMode = "auto"): SmartModelMode {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "auto") return "auto";
  if (["1", "true", "yes", "on"].includes(value)) return "on";
  if (["0", "false", "no", "off"].includes(value)) return "off";
  throw new Error(`${name} must be auto, on/true, or off/false`);
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

function namespacePatterns(name: string, fallback = "*"): string[] {
  const values = (process.env[name] ?? fallback)
    .split(",")
    .map((value: string) => value.trim())
    .filter(Boolean);
  if (!values.length) throw new Error(`${name} must contain at least one namespace pattern`);
  for (const value of values) {
    if (value === "*") continue;
    if (value.endsWith("*")) {
      const prefix = value.slice(0, -1);
      if (!prefix || prefix.includes("*") || prefix.includes("\n")) throw new Error(`${name} contains an invalid namespace pattern`);
      continue;
    }
    if (value.includes("*") || value.includes("\n")) throw new Error(`${name} contains an invalid namespace pattern`);
  }
  return [...new Set<string>(values)];
}

export interface Config {
  transport: TransportMode;
  host: string;
  port: number;
  mcpPath: string;
  allowedHosts: string[];
  apiKey: string | null;
  readOnlyAPIKey: string | null;
  adminNamespaces: string[];
  readOnlyNamespaces: string[];
  maxRequestBytes: number;
  databaseURL: string;
  databasePoolSize: number;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  openAIAPIKey: string | null;
  openAIBaseURL: string;
  ollamaBaseURL: string;
  googleAPIKey: string | null;
  googleBaseURL: string;
  openRouterAPIKey: string | null;
  openRouterBaseURL: string;
  openRouterSiteURL: string | null;
  openRouterAppName: string | null;
  embeddingTimeoutMs: number;
  embeddingRetryMax: number;
  embeddingCacheSize: number;
  embeddingCacheTTLSeconds: number;
  embeddingBatchSize: number;
  embeddingConcurrency: number;
  autoMigrate: boolean;
  enableAudit: boolean;
  publicBaseURL: string | null;
  oauthEnabled: boolean;
  oauthLoginPassword: string | null;
  oauthAllowRegistration: boolean;
  oauthAccessTokenTTLSeconds: number;
  oauthRefreshTokenTTLSeconds: number;
  oauthDefaultNamespaces: string[];
  exposeMaintenanceTools: boolean;
  toolProfile: McpToolProfile;
  contextDiversityLambda: number;
  contextRelationExpansion: boolean;
  contextRelationLimit: number;
  contextQueryDecomposition: boolean;
  adaptiveAccessWeight: number;
  adaptiveFeedbackWeight: number;
  logFormat: "text" | "json";
  logLevel: LogLevel;
  metricsEnabled: boolean;
  metricsPath: string;
  requestRateLimitPerMinute: number;
  oauthRateLimitPerMinute: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalSeconds: number;
  maintenanceReembedLimit: number;
  maintenanceConsolidationLimit: number;
  maintenanceArchiveExpired: boolean;
  smartModelEnabled: SmartModelMode;
  smartModel: string;
  smartModelAPIKey: string | null;
  smartModelBaseURL: string;
  smartModelMaxInputCharacters: number;
  smartModelMaxOutputTokens: number;
  smartModelLongInputThreshold: number;
  smartModelAmbiguousLexicalThreshold: number;
  smartModelDuplicateLexicalThreshold: number;
  smartModelCacheSize: number;
  smartModelCacheTTLSeconds: number;
  smartModelTimeoutMs: number;
  smartModelDailyCallBudget: number;
  smartModelDailyInputTokenBudget: number;
}

export function loadConfig(): Config {
  const transport = choice("MCP_TRANSPORT", "stdio", ["stdio", "http"] as const);
  const configuredEmbeddingProvider = choice("EMBEDDING_PROVIDER", "none", ["openai", "ollama", "google", "gemini", "openrouter", "none"] as const);
  const embeddingProvider: EmbeddingProviderName = configuredEmbeddingProvider === "gemini" ? "google" : configuredEmbeddingProvider;
  const embeddingDimensions = safeIndexDimension(integer("EMBEDDING_DIMENSIONS", 1536));
  const openAIAPIKey = process.env.OPENAI_API_KEY?.trim() || null;
  const googleAPIKey = process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || null;
  const openRouterAPIKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  if (embeddingProvider === "openai" && !openAIAPIKey) throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
  if (embeddingProvider === "google" && !googleAPIKey) throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is required when EMBEDDING_PROVIDER=google");
  if (embeddingProvider === "openrouter" && !openRouterAPIKey) throw new Error("OPENROUTER_API_KEY is required when EMBEDDING_PROVIDER=openrouter");
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

  const contextDiversityLambda = numberValue("CONTEXT_DIVERSITY_LAMBDA", 0.78);
  if (contextDiversityLambda < 0 || contextDiversityLambda > 1) throw new Error("CONTEXT_DIVERSITY_LAMBDA must be between 0 and 1");
  const adaptiveAccessWeight = numberValue("ADAPTIVE_ACCESS_WEIGHT", 0.025);
  const adaptiveFeedbackWeight = numberValue("ADAPTIVE_FEEDBACK_WEIGHT", 0.035);
  if (adaptiveAccessWeight < 0 || adaptiveAccessWeight > 0.2) throw new Error("ADAPTIVE_ACCESS_WEIGHT must be between 0 and 0.2");
  if (adaptiveFeedbackWeight < 0 || adaptiveFeedbackWeight > 0.2) throw new Error("ADAPTIVE_FEEDBACK_WEIGHT must be between 0 and 0.2");

  return {
    transport,
    host: process.env.HOST ?? (transport === "http" ? "0.0.0.0" : "127.0.0.1"),
    port: integer("PORT", 8787),
    mcpPath: process.env.MCP_PATH ?? "/mcp",
    allowedHosts,
    apiKey: (process.env.FOUNDATION_ADMIN_KEY ?? process.env.FOUNDATION_API_KEY)?.trim() || null,
    readOnlyAPIKey: process.env.FOUNDATION_READ_ONLY_KEY?.trim() || null,
    adminNamespaces: namespacePatterns("FOUNDATION_ADMIN_NAMESPACES"),
    readOnlyNamespaces: namespacePatterns("FOUNDATION_READ_ONLY_NAMESPACES"),
    maxRequestBytes: integer("MAX_REQUEST_BYTES", 1_048_576),
    databaseURL: process.env.DATABASE_URL ?? "postgresql://foundation:foundation@127.0.0.1:5432/foundation",
    databasePoolSize: integer("DATABASE_POOL_SIZE", 10),
    embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL ?? (
      embeddingProvider === "ollama"
        ? "nomic-embed-text"
        : embeddingProvider === "google"
          ? "gemini-embedding-001"
          : embeddingProvider === "openrouter"
            ? "openai/text-embedding-3-small"
            : "text-embedding-3-small"
    ),
    embeddingDimensions,
    openAIAPIKey,
    openAIBaseURL: serviceURL("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    ollamaBaseURL: serviceURL("OLLAMA_BASE_URL", "http://127.0.0.1:11434"),
    googleAPIKey,
    googleBaseURL: serviceURL("GOOGLE_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"),
    openRouterAPIKey,
    openRouterBaseURL: serviceURL("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    openRouterSiteURL: process.env.OPENROUTER_SITE_URL?.trim() || null,
    openRouterAppName: process.env.OPENROUTER_APP_NAME?.trim() || null,
    embeddingTimeoutMs: Math.max(1_000, Math.min(integer("EMBEDDING_TIMEOUT_MS", 30_000), 120_000)),
    embeddingRetryMax: Math.max(0, Math.min(integer("EMBEDDING_RETRY_MAX", 3), 10)),
    embeddingCacheSize: Math.max(0, Math.min(integer("EMBEDDING_CACHE_SIZE", 2_000), 100_000)),
    embeddingCacheTTLSeconds: Math.max(1, integer("EMBEDDING_CACHE_TTL_SECONDS", 3_600)),
    embeddingBatchSize: Math.max(1, Math.min(integer("EMBEDDING_BATCH_SIZE", 64), 512)),
    embeddingConcurrency: Math.max(1, Math.min(integer("EMBEDDING_CONCURRENCY", 4), 32)),
    autoMigrate: boolean("AUTO_MIGRATE", true),
    enableAudit: boolean("ENABLE_AUDIT", true),
    publicBaseURL: resolvedPublicURL,
    oauthEnabled,
    oauthLoginPassword,
    oauthAllowRegistration: boolean("OAUTH_ALLOW_DYNAMIC_REGISTRATION", true),
    oauthAccessTokenTTLSeconds,
    oauthRefreshTokenTTLSeconds,
    oauthDefaultNamespaces: namespacePatterns("OAUTH_DEFAULT_NAMESPACES"),
    exposeMaintenanceTools: boolean("EXPOSE_MAINTENANCE_TOOLS", false),
    toolProfile: choice("MCP_TOOL_PROFILE", "balanced", ["balanced", "full"] as const),
    contextDiversityLambda,
    contextRelationExpansion: boolean("CONTEXT_RELATION_EXPANSION", true),
    contextRelationLimit: Math.max(0, Math.min(integer("CONTEXT_RELATION_LIMIT", 2), 10)),
    contextQueryDecomposition: boolean("CONTEXT_QUERY_DECOMPOSITION", true),
    adaptiveAccessWeight,
    adaptiveFeedbackWeight,
    logFormat: choice("LOG_FORMAT", "text", ["text", "json"] as const),
    logLevel: choice("LOG_LEVEL", "info", ["debug", "info", "warn", "error"] as const),
    metricsEnabled: boolean("METRICS_ENABLED", false),
    metricsPath: process.env.METRICS_PATH?.trim() || "/metrics",
    requestRateLimitPerMinute: Math.max(0, integer("REQUEST_RATE_LIMIT_PER_MINUTE", 600)),
    oauthRateLimitPerMinute: Math.max(0, integer("OAUTH_RATE_LIMIT_PER_MINUTE", 60)),
    maintenanceEnabled: boolean("MAINTENANCE_ENABLED", false),
    maintenanceIntervalSeconds: Math.max(60, integer("MAINTENANCE_INTERVAL_SECONDS", 3_600)),
    maintenanceReembedLimit: Math.max(0, Math.min(integer("MAINTENANCE_REEMBED_LIMIT", 100), 5_000)),
    maintenanceConsolidationLimit: Math.max(0, Math.min(integer("MAINTENANCE_CONSOLIDATION_LIMIT", 100), 5_000)),
    maintenanceArchiveExpired: boolean("MAINTENANCE_ARCHIVE_EXPIRED", false),
    // Existing smart-model variables remain compatible. Everything below has
    // a conservative default so existing .env files do not need any changes.
    smartModelEnabled: smartModelMode("SMART_MODEL_ENABLED"),
    smartModel: process.env.SMART_MODEL?.trim() || "gpt-5.6-luna",
    smartModelAPIKey: (process.env.SMART_MODEL_API_KEY ?? process.env.OPENAI_API_KEY)?.trim() || null,
    smartModelBaseURL: (process.env.SMART_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    smartModelMaxInputCharacters: Math.max(500, Math.min(integer("SMART_MODEL_MAX_INPUT_CHARACTERS", 3_200), 20_000)),
    smartModelMaxOutputTokens: Math.max(100, Math.min(integer("SMART_MODEL_MAX_OUTPUT_TOKENS", 320), 2_000)),
    smartModelLongInputThreshold: Math.max(300, Math.min(integer("SMART_MODEL_LONG_INPUT_THRESHOLD", 900), 10_000)),
    smartModelAmbiguousLexicalThreshold: Math.max(0, Math.min(numberValue("SMART_MODEL_AMBIGUOUS_LEXICAL_THRESHOLD", 0.62), 1)),
    smartModelDuplicateLexicalThreshold: Math.max(0, Math.min(numberValue("SMART_MODEL_DUPLICATE_LEXICAL_THRESHOLD", 0.93), 1)),
    smartModelCacheSize: Math.max(0, Math.min(integer("SMART_MODEL_CACHE_SIZE", 2_000), 100_000)),
    smartModelCacheTTLSeconds: Math.max(60, integer("SMART_MODEL_CACHE_TTL_SECONDS", 604_800)),
    smartModelTimeoutMs: Math.max(1_000, Math.min(integer("SMART_MODEL_TIMEOUT_MS", 15_000), 120_000)),
    smartModelDailyCallBudget: Math.max(0, integer("SMART_MODEL_DAILY_CALL_BUDGET", 32)),
    smartModelDailyInputTokenBudget: Math.max(0, integer("SMART_MODEL_DAILY_INPUT_TOKEN_BUDGET", 24_000))
  };
}
