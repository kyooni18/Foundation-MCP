import type { SearchResult } from "./types.js";

export interface ContextCandidate extends SearchResult {
  relation_score?: number;
  relation_type?: string;
  seed_id?: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  // This deliberately errs slightly high for mixed Korean/English content.
  return Math.max(1, Math.ceil(ascii / 3.6 + nonAscii / 1.7));
}

function shingles(text: string): Set<string> {
  const normalized = text.toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return new Set(words);
  const result = new Set<string>();
  for (let index = 0; index < words.length - 1; index += 1) result.add(`${words[index]} ${words[index + 1]}`);
  return result;
}

function setSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return left.size === right.size ? 1 : 0;
  let intersection = 0;
  // Iterate the smaller set to reduce work for uneven documents.
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function contentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  return setSimilarity(shingles(a), shingles(b));
}

export function diversifyCandidates<T extends ContextCandidate>(
  candidates: T[],
  limit: number,
  lambda = 0.78
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  const available = candidates.map(item => ({ item, shingles: shingles(item.content), maxRedundancy: 0 }));
  const selected: T[] = [];
  const relevanceMax = Math.max(...available.map(entry => Math.max(0, entry.item.score)), 1e-9);

  while (available.length && selected.length < limit) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < available.length; index += 1) {
      const entry = available[index]!;
      const relevance = Math.max(0, entry.item.score) / relevanceMax;
      const value = lambda * relevance - (1 - lambda) * entry.maxRedundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }

    const [picked] = available.splice(bestIndex, 1);
    if (!picked) break;
    selected.push(picked.item);
    // Incrementally update each candidate's highest similarity to the selected
    // set instead of recomputing every selected pair on every iteration.
    for (const entry of available) {
      entry.maxRedundancy = Math.max(entry.maxRedundancy, setSimilarity(entry.shingles, picked.shingles));
    }
  }
  return selected;
}

export function decomposeQuery(query: string, maxParts = 3): string[] {
  const normalized = query.replace(/\r\n?/g, "\n").trim();
  if (normalized.length < 80) return [];
  const parts = normalized
    .split(/(?:\n+|[;]|(?<=[?.!。！？])\s+)/u)
    .map(part => part.trim())
    .filter(part => part.length >= 12 && part.length <= 2_000);
  const unique = [...new Set(parts)].filter(part => part !== normalized);
  return unique.length >= 2 ? unique.slice(0, maxParts) : [];
}

export function packContext<T extends ContextCandidate>(options: {
  candidates: T[];
  maxCharacters: number;
  maxTokens?: number;
  maxAtoms: number;
  diversityLambda: number;
}): { selected: T[]; lines: string[]; characters: number; estimatedTokens: number } {
  const diversified = diversifyCandidates(options.candidates, Math.min(options.maxAtoms * 3, options.candidates.length), options.diversityLambda);
  const selected: T[] = [];
  const lines: string[] = [];
  let characters = 0;
  let tokens = 0;

  for (const atom of diversified) {
    if (selected.length >= options.maxAtoms) break;
    const relation = atom.relation_type ? `, relation: ${atom.relation_type}` : "";
    const suffix = `(id: ${atom.id}, score: ${atom.score.toFixed(3)}${relation})`;
    const fullLine = `- [${atom.kind}] ${atom.content}${atom.summary ? ` — ${atom.summary}` : ""} ${suffix}`;
    const candidateLines = atom.summary
      ? [fullLine, `- [${atom.kind}] ${atom.summary} ${suffix}`]
      : [fullLine];

    let chosen: string | null = null;
    let chosenCharacters = characters;
    let chosenTokens = tokens;
    for (const line of candidateLines) {
      const nextCharacters = characters + line.length + (lines.length ? 1 : 0);
      const nextTokens = tokens + estimateTokens(line) + (lines.length ? 1 : 0);
      if (nextCharacters > options.maxCharacters) continue;
      if (options.maxTokens !== undefined && nextTokens > options.maxTokens) continue;
      chosen = line;
      chosenCharacters = nextCharacters;
      chosenTokens = nextTokens;
      break;
    }
    if (!chosen) continue;
    selected.push(atom);
    lines.push(chosen);
    characters = chosenCharacters;
    tokens = chosenTokens;
  }

  return { selected, lines, characters, estimatedTokens: tokens };
}
