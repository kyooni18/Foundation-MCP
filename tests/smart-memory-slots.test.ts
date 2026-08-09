import { describe, expect, it, vi } from "vitest";
import { SlotAwareSmartMemoryService, inferMemorySlot } from "../src/smart-memory-slots.js";
import type { Config } from "../src/config.js";
import type { SearchResult } from "../src/types.js";

function candidate(content: string, id = "11111111-1111-4111-8111-111111111111"): SearchResult {
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
    importance: 0.75,
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
    lexical_score: 0.9,
    recency_score: 1,
    access_score: 0,
    feedback_score: 0,
    score: 0.9
  };
}

describe("memory slots", () => {
  it("assigns the same slot when a Korean key-value fact changes value", () => {
    const oldSlot = inferMemorySlot("Foundation MCP의 tool profile은 full");
    const newSlot = inferMemorySlot("Foundation MCP의 tool profile은 balanced");

    expect(oldSlot?.slot).toBe("foundation-mcp:tool-profile");
    expect(newSlot?.slot).toBe(oldSlot?.slot);
  });

  it("does not preempt lifecycle resolution with current-value supersession", () => {
    expect(inferMemorySlot("Foundation's deployment status is resolved")).toBeNull();
    expect(inferMemorySlot("Foundation 배포 오류가 해결됐어")).toBeNull();
  });

  it("supersedes one unambiguous legacy atom without a smart-model call", async () => {
    const old = candidate("Foundation MCP의 tool profile은 full");
    const search = vi.fn(async () => ({ query: "", requestedMode: "lexical", effectiveMode: "lexical", results: [old] }));
    const supersede = vi.fn(async ({ oldAtomID, replacement }: any) => ({
      oldAtom: { ...old, status: "superseded" },
      replacementAtom: { ...old, ...replacement, id: "22222222-2222-4222-8222-222222222222", status: "active" },
      relation: { id: "33333333-3333-4333-8333-333333333333", relation_type: "supersedes" }
    }));
    const atoms = { search, supersede } as any;
    const service = new SlotAwareSmartMemoryService({} as Config, atoms);

    const result = await service.remember({ text: "Foundation MCP의 tool profile은 balanced" });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "Foundation MCP tool profile", mode: "lexical" }));
    expect(supersede).toHaveBeenCalledTimes(1);
    expect(supersede).toHaveBeenCalledWith(expect.objectContaining({
      oldAtomID: old.id,
      replacement: expect.objectContaining({
        content: "Foundation MCP의 tool profile은 balanced",
        metadata: expect.objectContaining({
          memory: expect.objectContaining({
            slot: "foundation-mcp:tool-profile",
            temporal: "current"
          })
        })
      })
    }));
    expect(result).toEqual(expect.objectContaining({
      stored: true,
      path: "deterministic",
      modelCalled: false,
      memorySlot: "foundation-mcp:tool-profile"
    }));
  });

  it("supports explicit stable slots for wording that cannot be inferred safely", () => {
    expect(inferMemorySlot("이제 밝은 테마를 쓰기로 했다", ["memory-slot:user.editor_theme"])?.slot)
      .toBe("explicit:user-editor-theme");
  });
});
