import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "../src/embeddings.js";
import type { Config } from "../src/config.js";

const originalFetch = globalThis.fetch;

function config(overrides: Partial<Config>): Config {
  return {
    embeddingProvider: "none",
    embeddingModel: "test-model",
    embeddingDimensions: 2,
    embeddingBatchSize: 64,
    embeddingConcurrency: 1,
    embeddingCacheSize: 0,
    embeddingCacheTTLSeconds: 60,
    embeddingRetryMax: 0,
    embeddingTimeoutMs: 1_000,
    openAIAPIKey: null,
    openAIBaseURL: "https://api.openai.com/v1",
    ollamaBaseURL: "http://127.0.0.1:11434",
    googleAPIKey: null,
    googleBaseURL: "https://generativelanguage.googleapis.com/v1beta",
    openRouterAPIKey: null,
    openRouterBaseURL: "https://openrouter.ai/api/v1",
    openRouterSiteURL: null,
    openRouterAppName: null,
    ...overrides
  } as Config;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("EmbeddingService providers", () => {
  it("sends Google batch requests with query task type and maps values", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("google-secret");
      const body = JSON.parse(String(init?.body)) as { requests: Array<Record<string, unknown>> };
      expect(body.requests).toHaveLength(2);
      expect(body.requests[0]).toMatchObject({
        model: "models/gemini-embedding-001",
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 2,
        embedContentConfig: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 2 }
      });
      return new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new EmbeddingService(config({ embeddingProvider: "google", googleAPIKey: "google-secret", embeddingModel: "gemini-embedding-001" }));
    const results = await service.embedMany(["first", "second"], "query");
    expect(results.map(result => result?.provider)).toEqual(["google", "google"]);
    expect(results.map(result => result?.vector)).toEqual([[1, 0], [0, 1]]);
  });

  it("uses OpenRouter's OpenAI-compatible response and optional attribution headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer router-secret");
      expect(headers.get("http-referer")).toBe("https://example.test");
      expect(headers.get("x-title")).toBe("Foundation MCP");
      return new Response(JSON.stringify({ data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] }
      ] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new EmbeddingService(config({
      embeddingProvider: "openrouter",
      openRouterAPIKey: "router-secret",
      openRouterSiteURL: "https://example.test",
      openRouterAppName: "Foundation MCP"
    }));
    const results = await service.embedMany(["first", "second"]);
    expect(results.map(result => result?.provider)).toEqual(["openrouter", "openrouter"]);
    expect(results.map(result => result?.vector)).toEqual([[1, 0], [0, 1]]);
  });

  it("retries a transient HTTP error and honors Retry-After", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new EmbeddingService(config({
      embeddingProvider: "openrouter",
      openRouterAPIKey: "router-secret",
      embeddingRetryMax: 1
    }));
    await expect(service.embed("retry me")).resolves.toMatchObject({ provider: "openrouter", vector: [1, 0] });
    expect(calls).toBe(2);
  });

  it("does not retry non-transient provider errors", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "invalid key" }), { status: 401 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new EmbeddingService(config({
      embeddingProvider: "openrouter",
      openRouterAPIKey: "router-secret",
      embeddingRetryMax: 3
    }));
    await expect(service.embed("no retry")).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });
});
