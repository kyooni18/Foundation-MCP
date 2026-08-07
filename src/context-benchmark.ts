#!/usr/bin/env node
import { contentSimilarity, diversifyCandidates, estimateTokens } from "./context-planner.js";
import type { SearchResult } from "./types.js";

function fakeAtom(index: number, group: number): SearchResult {
  const now = new Date();
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    namespace: "benchmark",
    content: `Project preference group ${group}: use deterministic memory retrieval with variation ${index}`,
    normalized_content: "",
    content_hash: "",
    summary: null,
    kind: "fact",
    status: "active",
    importance: 0.5,
    confidence: 1,
    tags: [], metadata: {}, source: {}, embedding_provider: null, embedding_model: null, embedding_dimensions: null,
    version: 1, access_count: 0, last_accessed_at: null, expires_at: null, created_at: now, updated_at: now,
    semantic_score: Math.max(0, 1 - index / 500), lexical_score: 0.5, recency_score: 1, access_score: 0, feedback_score: 0,
    score: Math.max(0, 1 - index / 500)
  };
}

const count = Math.max(100, Math.min(Number(process.argv[2] ?? 10_000), 100_000));
const items = Array.from({ length: count }, (_, index) => fakeAtom(index, Math.floor(index / 5)));
const started = process.hrtime.bigint();
const selected = diversifyCandidates(items, 50, 0.78);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
console.log(JSON.stringify({
  candidates: count,
  selected: selected.length,
  elapsed_ms: Number(elapsedMs.toFixed(3)),
  first_pair_similarity: selected.length > 1 ? contentSimilarity(selected[0]!.content, selected[1]!.content) : 0,
  estimated_tokens: estimateTokens(selected.map(item => item.content).join("\n"))
}, null, 2));
