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

  async embed(text: string): Promise<EmbeddingResult | null> {
    const results = await this.embedMany([text]);
    return results[0] ?? null;
  }

  async embedMany(texts: string[]): Promise<Array<EmbeddingResult | null>> {
    if (this.config.embeddingProvider === "none") return texts.map(() => null);
    if (!texts.length) return [];

    const outputs: Array<EmbeddingResult | null> = new Array(texts.length).fill(null);
    const missingByKey = new Map<string, { key: string; text: string; indices: number[] }>();
    const now = Date.now();
    texts.forEach((text, index) => {
      const key = this.cacheKey(text);
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
      const embedded = await this.requestBatch(batch.map(item => item.text));
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

  private async requestBatch(texts: string[]): Promise<EmbeddingResult[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.embeddingRetryMax; attempt += 1) {
      try {
        this.providerRequests += 1;
        metrics.increment("embedding_provider_requests_total");
        const started = process.hrtime.bigint();
        const results = this.config.embeddingProvider === "openai"
          ? await this.embedOpenAI(texts)
          : await this.embedOllama(texts);
        metrics.observe("embedding_provider", Number(process.hrtime.bigint() - started) / 1e9);
        return results;
      } catch (error) {
        lastError = error;
        this.providerFailures += 1;
        metrics.increment("embedding_provider_errors_total");
        if (attempt >= this.config.embeddingRetryMax || !this.retryable(error)) break;
        const delay = Math.min(4_000, 200 * 2 ** attempt) + Math.floor(Math.random() * 100);
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

    const response = await fetch(`${this.config.openAIBaseURL}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openAIAPIKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map(item => this.embeddingResult(item.embedding, "openai"));
  }

  private async embedOllama(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.config.ollamaBaseURL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.embeddingModel, input: texts }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`);
    const payload = await response.json() as { embeddings?: number[][] };
    return (payload.embeddings ?? []).map(vector => this.embeddingResult(vector, "ollama"));
  }

  private embeddingResult(vector: number[] | undefined, provider: string): EmbeddingResult {
    if (!vector) throw new Error("Embedding provider returned no vector");
    this.assertDimensions(vector);
    return { vector, provider, model: this.config.embeddingModel, dimensions: vector.length };
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.config.embeddingDimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.config.embeddingDimensions}, received ${vector.length}`);
    }
    if (vector.some(value => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value");
  }

  private cacheKey(text: string): string {
    return `${this.config.embeddingProvider}:${this.config.embeddingModel}:${this.config.embeddingDimensions}:${sha256(text)}`;
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
    const message = error instanceof Error ? error.message : String(error);
    const status = /HTTP (\d{3})/.exec(message)?.[1];
    if (!status) return /timeout|fetch failed|ECONN|socket/i.test(message);
    const code = Number(status);
    return code === 408 || code === 409 || code === 429 || code >= 500;
  }
}
