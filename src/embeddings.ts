import type { Config } from "./config.js";

export interface EmbeddingResult {
  vector: number[];
  provider: string;
  model: string;
  dimensions: number;
}

export class EmbeddingService {
  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return this.config.embeddingProvider !== "none";
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    if (this.config.embeddingProvider === "none") return null;
    if (this.config.embeddingProvider === "openai") return this.embedOpenAI(text);
    return this.embedOllama(text);
  }

  private async embedOpenAI(text: string): Promise<EmbeddingResult> {
    if (!this.config.openAIAPIKey) throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    const body: Record<string, unknown> = {
      model: this.config.embeddingModel,
      input: text,
      encoding_format: "float"
    };
    if (this.config.embeddingModel.startsWith("text-embedding-3-")) {
      body.dimensions = this.config.embeddingDimensions;
    }

    const response = await fetch(`${this.config.openAIBaseURL}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openAIAPIKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const vector = payload.data?.[0]?.embedding;
    if (!vector) throw new Error("Embedding provider returned no vector");
    this.assertDimensions(vector);
    return { vector, provider: "openai", model: this.config.embeddingModel, dimensions: vector.length };
  }

  private async embedOllama(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.config.ollamaBaseURL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.embeddingModel, input: text }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { embeddings?: number[][] };
    const vector = payload.embeddings?.[0];
    if (!vector) throw new Error("Ollama returned no embedding");
    this.assertDimensions(vector);
    return { vector, provider: "ollama", model: this.config.embeddingModel, dimensions: vector.length };
  }

  private assertDimensions(vector: number[]): void {
    if (vector.length !== this.config.embeddingDimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.config.embeddingDimensions}, received ${vector.length}`);
    }
    if (vector.some(value => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value");
  }
}
