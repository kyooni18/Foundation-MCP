#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { estimateTokens } from "./context-planner.js";
import { jsonText } from "./utils.js";

type BenchmarkMode = "hybrid" | "semantic" | "lexical";
interface BenchmarkCase {
  name?: string;
  query: string;
  namespace?: string;
  relevantAtomIDs: string[];
  mode?: BenchmarkMode;
  limit?: number;
}

function reciprocalRank(returned: string[], relevant: Set<string>): number {
  const index = returned.findIndex(id => relevant.has(id));
  return index < 0 ? 0 : 1 / (index + 1);
}

function dcg(returned: string[], relevant: Set<string>): number {
  return returned.reduce((score, id, index) => score + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
}

function ndcg(returned: string[], relevant: Set<string>): number {
  const ideal = Array.from({ length: Math.min(returned.length, relevant.size) }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((a, b) => a + b, 0);
  return ideal ? dcg(returned, relevant) / ideal : 0;
}

async function main(): Promise<void> {
  const filename = process.argv[2];
  if (!filename) throw new Error("Usage: foundation-retrieval-benchmark <cases.json>");
  const cases = JSON.parse(readFileSync(filename, "utf8")) as BenchmarkCase[];
  if (!Array.isArray(cases) || !cases.length) throw new Error("Benchmark file must contain a non-empty JSON array");

  const config = loadConfig();
  const database = new Database(config);
  await database.initialize();
  const atoms = new AtomService(database, new EmbeddingService(config));
  try {
    const results: Array<Record<string, unknown>> = [];
    for (const [index, entry] of cases.entries()) {
      if (!entry.query || !Array.isArray(entry.relevantAtomIDs) || !entry.relevantAtomIDs.length) {
        throw new Error(`Invalid benchmark case at index ${index}`);
      }
      const relevant = new Set(entry.relevantAtomIDs);
      const started = performance.now();
      const search = await atoms.search({
        query: entry.query,
        namespace: entry.namespace,
        mode: entry.mode ?? "hybrid",
        limit: entry.limit ?? 10
      });
      const latencyMs = performance.now() - started;
      const returned = search.results.map(atom => atom.id);
      const found = returned.filter(id => relevant.has(id)).length;
      results.push({
        name: entry.name ?? `case-${index + 1}`,
        effectiveMode: search.effectiveMode,
        recallAtK: found / relevant.size,
        reciprocalRank: reciprocalRank(returned, relevant),
        ndcgAtK: ndcg(returned, relevant),
        latencyMs,
        resultCount: returned.length,
        estimatedResultTokens: estimateTokens(search.results.map(atom => atom.content).join("\n"))
      });
    }

    const average = (field: string): number => results.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / results.length;
    console.log(jsonText({
      cases: results.length,
      averages: {
        recallAtK: average("recallAtK"),
        mrr: average("reciprocalRank"),
        ndcgAtK: average("ndcgAtK"),
        latencyMs: average("latencyMs"),
        estimatedResultTokens: average("estimatedResultTokens")
      },
      results
    }));
  } finally {
    await database.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
