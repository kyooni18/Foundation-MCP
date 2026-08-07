import { describe, expect, it } from "vitest";
import { contentSimilarity, decomposeQuery, diversifyCandidates, estimateTokens, packContext } from "../src/context-planner.js";
import type { ContextCandidate } from "../src/context-planner.js";

function candidate(id: string, content: string, score: number): ContextCandidate {
  const now = new Date();
  return {
    id,
    namespace: "test",
    content,
    normalized_content: content,
    content_hash: id.padEnd(64, "0").slice(0, 64),
    summary: null,
    kind: "fact",
    status: "active",
    importance: 0.5,
    confidence: 1,
    tags: [],
    metadata: {},
    source: {},
    embedding_provider: null,
    embedding_model: null,
    embedding_dimensions: null,
    version: 1,
    access_count: 0,
    last_accessed_at: null,
    expires_at: null,
    created_at: now,
    updated_at: now,
    semantic_score: score,
    lexical_score: score,
    recency_score: 1,
    access_score: 0,
    feedback_score: 0,
    score
  };
}

describe("context planner", () => {
  it("estimates mixed-language token budgets conservatively", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("한글 테스트")).toBeGreaterThan(0);
  });

  it("detects content redundancy and diversifies near-duplicates", () => {
    expect(contentSimilarity("alpha beta gamma", "alpha beta delta")).toBeGreaterThan(0);
    const selected = diversifyCandidates([
      candidate("a", "Calcite hides DS Store files in the project tree", 1),
      candidate("b", "Calcite hides DS Store files in the project tree", 0.99),
      candidate("c", "The editor persists split pane layout", 0.8)
    ], 2, 0.65);
    expect(selected.map(item => item.id)).toContain("a");
    expect(selected.map(item => item.id)).toContain("c");
  });

  it("decomposes long multi-part questions", () => {
    const parts = decomposeQuery("Explain how retrieval ranking works and why it is stable. Also explain how namespace permissions are enforced. Finally describe migration behavior for older databases.");
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });


  it("falls back to summaries when full content does not fit", () => {
    const item = candidate("a", "x".repeat(2_000), 1);
    item.summary = "compact durable summary";
    const packed = packContext({
      candidates: [item],
      maxCharacters: 256,
      maxTokens: 80,
      maxAtoms: 1,
      diversityLambda: 0.78
    });
    expect(packed.selected).toHaveLength(1);
    expect(packed.lines[0]).toContain("compact durable summary");
    expect(packed.lines[0]).not.toContain("x".repeat(100));
  });

  it("packs within both character and token limits", () => {
    const packed = packContext({
      candidates: [candidate("a", "short fact", 1), candidate("b", "another independent fact", 0.8)],
      maxCharacters: 256,
      maxTokens: 50,
      maxAtoms: 2,
      diversityLambda: 0.78
    });
    expect(packed.characters).toBeLessThanOrEqual(256);
    expect(packed.estimatedTokens).toBeLessThanOrEqual(50);
  });
});
