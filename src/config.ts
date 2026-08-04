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
}

export function loadConfig(): Config {
  const transport = choice("MCP_TRANSPORT", "stdio", ["stdio", "http"] as const);
  const embeddingProvider = choice("EMBEDDING_PROVIDER", "none", ["openai", "ollama", "none"] as const);
  const embeddingDimensions = safeIndexDimension(integer("EMBEDDING_DIMENSIONS", 1536));
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((value: string) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    transport,
    host: process.env.HOST ?? "127.0.0.1",
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
    enableAudit: boolean("ENABLE_AUDIT", true)
  };
}
