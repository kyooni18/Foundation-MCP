import type { Config } from "./config.js";
import { metrics } from "./telemetry.js";
import { mapLimit, sha256 } from "./utils.js";

export interface EmbeddingResult {
  vector: number[];
  provider: string;
  model: string;
  dimensions: number;
}

interface CacheEntry {
  expiresAt: number;
  value: EmbeddingResult;
}

type EmbeddingPurpose = "document" | "query";

class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly networkCode?: string,
    readonly retryableError = false
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class EmbeddingService {
  private readonly cache = new Map<string, CacheEntry>();
  private providerRequests = 0;
  private providerFailures = 0;
  private cacheHits = 0;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return this.config.embeddingProvider !== "none";
  }

  stats(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      provider: this.config.embeddingProvider,
      model: this.config.embeddingModel,
      dimensions: this.config.embeddingDimensions,
      cache_entries: this.cache.size,
      cache_hits: this.cacheHits,
      provider_requests: this.providerRequests,
      provider_failures: this.providerFailures
    };
  }

  async embed(text: string, purpose: EmbeddingPurpose = "document"): Promise<EmbeddingResult | null> {
    const results = await this.embedMany([text], purpose);
    return results[0] ?? null;
  }

  async embedMany(texts: string[], purpose: EmbeddingPurpose = "document"): Promise<Array<EmbeddingResult | null>> {
    if (this.config.embeddingProvider === "none") return texts.map(() => null);
    if (!texts.length) return [];

    const outputs: Array<EmbeddingResult | null> = new Array(texts.length).fill(null);
    const missingByKey = new Map<string, { key: string; text: string; indices: number[] }>();
    const now = Date.now();
    texts.forEach((text, index) => {
      const key = this.cacheKey(text, purpose);
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > now) {
        this.cacheHits += 1;
        metrics.increment("embedding_cache_hits_total");
        this.cache.delete(key);
        this.cache.set(key, cached);
        outputs[index] = cached.value;
      } else {
        if (cached) this.cache.delete(key);
        const group = missingByKey.get(key);
        if (group) group.indices.push(index);
        else missingByKey.set(key, { key, text, indices: [index] });
      }
    });

    const missing = [...missingByKey.values()];
    const batches: Array<typeof missing> = [];
    for (let offset = 0; offset < missing.length; offset += this.config.embeddingBatchSize) {
      batches.push(missing.slice(offset, offset + this.config.embeddingBatchSize));
    }

    const completed = await mapLimit(batches, this.config.embeddingConcurrency, async batch => {
      const embedded = await this.requestBatch(batch.map(item => item.text), purpose);
      if (embedded.length !== batch.length) throw new Error("Embedding provider returned an unexpected batch size");
      return batch.map((item, index) => ({ item, value: embedded[index]! }));
    });

    for (const batch of completed) {
      for (const { item, value } of batch) {
        this.cacheSet(item.key, value);
        for (const index of item.indices) outputs[index] = value;
      }
    }
    return outputs;
  }

  private async requestBatch(texts: string[], purpose: EmbeddingPurpose): Promise<EmbeddingResult[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.embeddingRetryMax; attempt += 1) {
      try {
        this.providerRequests += 1;
        metrics.increment("embedding_provider_requests_total");
        const started = process.hrtime.bigint();
        const results = this.config.embeddingProvider === "openai"
          ? await this.embedOpenAI(texts)
          : this.config.embeddingProvider === "ollama"
            ? await this.embedOllama(texts)
            : this.config.embeddingProvider === "google"
              ? await this.embedGoogle(texts, purpose)
              : this.config.embeddingProvider === "openrouter"
                ? await this.embedOpenRouter(texts)
                : (() => { throw new Error(`Unsupported embedding provider: ${this.config.embeddingProvider}`); })();
        metrics.observe("embedding_provider", Number(process.hrtime.bigint() - started) / 1e9);
        return results;
      } catch (error) {
        lastError = error;
        this.providerFailures += 1;
        metrics.increment("embedding_provider_errors_total");
        if (attempt >= this.config.embeddingRetryMax || !this.retryable(error)) break;
        const providerDelay = error instanceof ProviderRequestError ? error.retryAfterMs : undefined;
        const delay = providerDelay ?? (Math.min(4_000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async embedOpenAI(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.config.openAIAPIKey) throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    const body: Record<string, unknown> = {
      model: this.config.embeddingModel,
      input: texts,
      encoding_format: "float"
    };
    if (this.config.embeddingModel.startsWith("text-embedding-3-")) body.dimensions = this.config.embeddingDimensions;

    const payload = await this.requestJSON("openai", `${this.config.openAIBaseURL}/embeddings`, body, {
      authorization: `Bearer ${this.config.openAIAPIKey}`
    });
    return this.openAICompatibleResults(payload, "openai");
  }

  private async embedOllama(texts: string[]): Promise<EmbeddingResult[]> {
    const payload = await this.requestJSON("ollama", `${this.config.ollamaBaseURL}/api/embed`, {
      model: this.config.embeddingModel,
      input: texts
    });
    const embeddings = (payload as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings)) throw new Error("Ollama returned no embeddings array");
    return embeddings.map(vector => this.embeddingResult(vector as number[], "ollama"));
  }

  private async embedOpenRouter(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.config.openRouterAPIKey) throw new Error("OPENROUTER_API_KEY is required when EMBEDDING_PROVIDER=openrouter");
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.openRouterAPIKey}`
    };
    if (this.config.openRouterSiteURL) headers["http-referer"] = this.config.openRouterSiteURL;
    if (this.config.openRouterAppName) headers["x-title"] = this.config.openRouterAppName;
    const payload = await this.requestJSON("openrouter", `${this.config.openRouterBaseURL}/embeddings`, {
      model: this.config.embeddingModel,
      input: texts
    }, headers);
    return this.openAICompatibleResults(payload, "openrouter");
  }

  private async embedGoogle(texts: string[], purpose: EmbeddingPurpose): Promise<EmbeddingResult[]> {
    if (!this.config.googleAPIKey) throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is required when EMBEDDING_PROVIDER=google");
    const modelName = this.config.embeddingModel.startsWith("models/")
      ? this.config.embeddingModel.slice("models/".length)
      : this.config.embeddingModel;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(modelName)) {
      throw new Error("EMBEDDING_MODEL must be a valid Google model name when EMBEDDING_PROVIDER=google");
    }
    const modelResource = `models/${modelName}`;
    const payload = await this.requestJSON(
      "google",
      `${this.config.googleBaseURL}/${modelResource}:batchEmbedContents`,
      {
        requests: texts.map(text => {
          const taskType = purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
          return {
            model: modelResource,
            content: { parts: [{ text }] },
            // Keep the deprecated top-level fields for batch endpoint versions
            // that ignore embedContentConfig.outputDimensionality.
            taskType,
            outputDimensionality: this.config.embeddingDimensions,
            embedContentConfig: { taskType, outputDimensionality: this.config.embeddingDimensions }
          };
        })
      },
      { "x-goog-api-key": this.config.googleAPIKey }
    );
    const embeddings = (payload as { embeddings?: Array<{ values?: number[] }> }).embeddings;
    if (!Array.isArray(embeddings)) throw new Error("Google returned no embeddings array");
    return embeddings.map(item => this.embeddingResult(item?.values, "google"));
  }

  private async requestJSON(
    provider: string,
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.embeddingTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 1_000);
        throw new ProviderRequestError(
          `${provider} embedding request returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status,
          retryAfterMs(response.headers.get("retry-after")),
          undefined,
          isRetryableStatus(response.status)
        );
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`${provider} embedding provider returned invalid JSON`);
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (timedOut) throw new ProviderRequestError(`${provider} embedding request timed out after ${this.config.embeddingTimeoutMs}ms`, 408, undefined, "ETIMEDOUT", true);
      throw networkError(provider, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private openAICompatibleResults(payload: unknown, provider: string): EmbeddingResult[] {
    const data = (payload as { data?: Array<{ index?: number; embedding?: number[] }> }).data;
    if (!Array.isArray(data)) throw new Error(`${provider} returned no data array`);
    const ordered = data
      .map((item, position) => ({ item, index: item?.index ?? position }))
      .sort((a, b) => a.index - b.index);
    const indexes = ordered.map(entry => entry.index);
    if (indexes.some(index => !Number.isInteger(index) || index < 0) || new Set(indexes).size !== indexes.length) {
      throw new Error(`${provider} returned invalid embedding indexes`);
    }
    return ordered.map(entry => this.embeddingResult(entry.item?.embedding, provider));
  }

  private embeddingResult(vector: number[] | undefined, provider: string): EmbeddingResult {
    if (!Array.isArray(vector)) throw new Error("Embedding provider returned no vector");
    this.assertDimensions(vector);
    return { vector, provider, model: this.config.embeddingModel, dimensions: vector.length };
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.config.embeddingDimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.config.embeddingDimensions}, received ${vector.length}`);
    }
    if (vector.some(value => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value");
  }

  private cacheKey(text: string, purpose: EmbeddingPurpose): string {
    return `${this.config.embeddingProvider}:${this.config.embeddingModel}:${this.config.embeddingDimensions}:${purpose}:${sha256(text)}`;
  }

  private cacheSet(key: string, value: EmbeddingResult): void {
    if (this.config.embeddingCacheSize <= 0) return;
    this.cache.set(key, { expiresAt: Date.now() + this.config.embeddingCacheTTLSeconds * 1_000, value });
    while (this.cache.size > this.config.embeddingCacheSize) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private retryable(error: unknown): boolean {
    if (error instanceof ProviderRequestError) return error.retryableError;
    return false;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(30_000, Math.max(0, timestamp - Date.now()));
}

function networkError(provider: string, error: unknown): ProviderRequestError {
  const source = error as { cause?: { code?: string; message?: string }; code?: string; message?: string };
  const code = source.cause?.code ?? source.code;
  const detail = source.cause?.message ?? source.message ?? String(error);
  const retryableCodes = new Set(["EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
  const retryableError = !code || retryableCodes.has(code);
  return new ProviderRequestError(
    `${provider} embedding network request failed${code ? ` (${code})` : ""}: ${detail}`,
    undefined,
    undefined,
    code,
    retryableError
  );
}
