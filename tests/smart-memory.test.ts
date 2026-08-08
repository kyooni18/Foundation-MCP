import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartMemoryService } from "../src/smart-memory.js";
import type { Config } from "../src/config.js";
import type { SearchResult } from "../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    smartModelEnabled: "auto",
    smartModel: "gpt-5.6-luna",
    smartModelAPIKey: "test-key",
    smartModelBaseURL: "https://api.openai.com/v1",
    smartModelMaxInputCharacters: 3_200,
    smartModelMaxOutputTokens: 320,
    smartModelLongInputThreshold: 900,
    smartModelAmbiguousLexicalThreshold: 0.62,
    smartModelDuplicateLexicalThreshold: 0.93,
    smartModelCacheSize: 2_000,
    smartModelCacheTTLSeconds: 604_800,
    smartModelTimeoutMs: 15_000,
    smartModelDailyCallBudget: 32,
    smartModelDailyInputTokenBudget: 24_000,
    ...overrides
  } as Config;
}

function candidate(content: string, lexical = 0.7, id = "11111111-1111-4111-8111-111111111111"): SearchResult {
  const now = new Date();
  return {
    id,
    namespace: "default",
    content,
    normalized_content: content,
    content_hash: "a".repeat(64),
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
    semantic_score: 0,
    lexical_score: lexical,
    recency_score: 1,
    access_score: 0,
    feedback_score: 0,
    score: lexical
  };
}

function fakeAtoms(results: SearchResult[] = []) {
  return {
    search: vi.fn(async () => ({ query: "", effectiveMode: "lexical", results })),
    context: vi.fn(async () => ({ context: "packed", atomCount: 1 })),
    create: vi.fn(async (input: any) => ({
      created: true,
      deduplicated: false,
      atom: { id: crypto.randomUUID(), status: "active", ...input }
    })),
    update: vi.fn(async (input: any) => {
      const current = results.find(item => item.id === input.id);
      return { ...(current ?? { id: input.id, metadata: {} }), ...input };
    }),
    supersede: vi.fn(async ({ oldAtomID, replacement }: any) => ({
      oldAtom: { id: oldAtomID, status: "superseded" },
      replacementAtom: { id: crypto.randomUUID(), status: "active", ...replacement },
      relation: { id: crypto.randomUUID(), relation_type: "supersedes" }
    }))
  };
}

function smartResponse(
  content: string,
  action: "create" | "skip" | "supersede" | "resolve" | "deprecate" = "create",
  targetAtomId: string | null = null
) {
  return new Response(JSON.stringify({
    output_text: JSON.stringify({
      atoms: [{ content, kind: "fact", importance: 0.6, action, targetAtomId }]
    }),
    usage: { input_tokens: 120, output_tokens: 28 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("smart memory cost controls", () => {
  it("never calls the smart model on recall", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms();
    const service = new SmartMemoryService(config(), atoms as any);

    const result = await service.recall({ query: "remembered preference" });

    expect(result).toEqual({ context: "packed", atomCount: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.stats().avoidedReadPath).toBe(1);
  });

  it("stores simple memory deterministically without a model call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms();
    const service = new SmartMemoryService(config(), atoms as any);

    const result = await service.remember({ text: "The preferred editor theme is dark mode." });

    expect(result.path).toBe("deterministic");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(atoms.create).toHaveBeenCalledTimes(1);
  });

  it("skips a strong lexical duplicate without a model call", async () => {
    const text = "The preferred editor theme is dark mode";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([candidate(text, 0.99)]);
    const service = new SmartMemoryService(config(), atoms as any);

    const result = await service.remember({ text });

    expect(result.path).toBe("deterministic");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(atoms.create).not.toHaveBeenCalled();
    expect((result.results as any[])[0].action).toBe("skip");
  });

  it("uses at most one model call for an ambiguous write and caches the decision", async () => {
    const text = "The project target may have changed from the previous target, but the wording is intentionally ambiguous.";
    const fetchMock = vi.fn(async () => smartResponse(text));
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([candidate("The project target is the previous target", 0.72)]);
    const service = new SmartMemoryService(config({ smartModelLongInputThreshold: 10_000 }), atoms as any);

    const first = await service.remember({ text, store: false });
    const second = await service.remember({ text, store: false });

    expect(first.path).toBe("model");
    expect(second.path).toBe("cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.stats().calls).toBe(1);
    expect(service.stats().cacheHits).toBe(1);
  });

  it("retires a resolved problem instead of leaving the stale atom active", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const old = candidate("Foundation deployment bug is still unresolved", 0.86, id);
    const text = "Foundation deployment bug has been resolved.";
    const fetchMock = vi.fn(async () => smartResponse(text, "resolve", id));
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([old]);
    const service = new SmartMemoryService(config({ smartModelLongInputThreshold: 10_000 }), atoms as any);

    const result = await service.remember({ text });

    expect(result.path).toBe("model");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(atoms.update).toHaveBeenCalledTimes(1);
    expect(atoms.update).toHaveBeenCalledWith(expect.objectContaining({ id, status: "resolved" }));
    const update = atoms.update.mock.calls[0]![0];
    expect(update.metadata.lifecycle).toEqual(expect.objectContaining({
      state: "resolved",
      reason: text,
      managed_by: "memory_remember"
    }));
    expect(atoms.create).not.toHaveBeenCalled();
    expect((result.results as any[])[0]).toEqual(expect.objectContaining({ action: "resolve", atomID: id, status: "resolved" }));
  });

  it("does not let a lifecycle update take the strong-duplicate skip shortcut", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const text = "The old workaround is no longer used and is deprecated.";
    const fetchMock = vi.fn(async () => smartResponse(text, "deprecate", id));
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([candidate(text, 0.99, id)]);
    const service = new SmartMemoryService(config({ smartModelLongInputThreshold: 10_000 }), atoms as any);

    const result = await service.remember({ text });

    expect(result.path).toBe("model");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(atoms.update).toHaveBeenCalledWith(expect.objectContaining({ id, status: "deprecated" }));
    expect(atoms.create).not.toHaveBeenCalled();
  });

  it("falls back to deterministic storage after the built-in daily call budget is exhausted", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const text = String(body.input).match(/text=(.*)/)?.[1]?.split("\n")[0] ?? "memory";
      return smartResponse(text);
    });
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([candidate("An older project setting exists", 0.7)]);
    const service = new SmartMemoryService(config({
      smartModelDailyCallBudget: 1,
      smartModelDailyInputTokenBudget: 0,
      smartModelLongInputThreshold: 10_000,
      smartModelCacheSize: 0
    }), atoms as any);

    const first = await service.remember({ text: "The current project setting could supersede the older setting A", store: false });
    const second = await service.remember({ text: "The current project setting could supersede the older setting B", store: false });

    expect(first.path).toBe("model");
    expect(second.path).toBe("deterministic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.stats().avoidedBudget).toBeGreaterThanOrEqual(1);
  });

  it("keeps auto mode model-free when no smart credential or compatible local endpoint exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const atoms = fakeAtoms([candidate("Related existing memory", 0.75)]);
    const service = new SmartMemoryService(config({ smartModelAPIKey: null, smartModelBaseURL: "https://api.openai.com/v1" }), atoms as any);

    const result = await service.remember({ text: "Potentially related memory that would otherwise be ambiguous", store: false });

    expect(result.path).toBe("deterministic");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.stats().enabled).toBe(false);
  });
});
