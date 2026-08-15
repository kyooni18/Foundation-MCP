import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "MCP_TOOL_PROFILE",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_BASE_URL",
  "OPENROUTER_BASE_URL"
] as const;
const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("MCP_TOOL_PROFILE", () => {
  it("defaults to balanced", () => {
    delete process.env.MCP_TOOL_PROFILE;
    expect(loadConfig().toolProfile).toBe("balanced");
  });

  it("accepts full", () => {
    process.env.MCP_TOOL_PROFILE = "full";
    expect(loadConfig().toolProfile).toBe("full");
  });

  it("rejects unknown profiles", () => {
    process.env.MCP_TOOL_PROFILE = "unknown";
    expect(() => loadConfig()).toThrow(/MCP_TOOL_PROFILE/);
  });
});

describe("embedding providers", () => {
  it("loads Google with its Gemini API key alias and model default", () => {
    process.env.EMBEDDING_PROVIDER = "google";
    process.env.GEMINI_API_KEY = "test-google-key";
    const config = loadConfig();
    expect(config.embeddingModel).toBe("gemini-embedding-001");
    expect(config.googleAPIKey).toBe("test-google-key");
    expect(config.googleBaseURL).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("accepts gemini as a Google provider alias", () => {
    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-google-key";
    expect(loadConfig().embeddingProvider).toBe("google");
  });

  it("loads OpenRouter with an OpenAI-compatible model default", () => {
    process.env.EMBEDDING_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const config = loadConfig();
    expect(config.embeddingModel).toBe("openai/text-embedding-3-small");
    expect(config.openRouterAPIKey).toBe("test-openrouter-key");
  });

  it("fails fast when a selected remote provider has no credential", () => {
    process.env.EMBEDDING_PROVIDER = "google";
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(() => loadConfig()).toThrow(/GOOGLE_API_KEY or GEMINI_API_KEY/);
  });

  it("rejects malformed provider endpoints", () => {
    process.env.OPENROUTER_BASE_URL = "not-a-url";
    expect(() => loadConfig()).toThrow(/OPENROUTER_BASE_URL/);
  });
});
