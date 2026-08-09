import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AtomService } from "../src/atom-service.js";
import type { Database } from "../src/db.js";
import type { SmartMemoryService } from "../src/smart-memory.js";

const { registeredTools } = vi.hoisted(() => ({ registeredTools: [] as string[] }));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool(name: string): void { registeredTools.push(name); }
    registerResource(): void {}
    registerPrompt(): void {}
  }
}));

import { createMcpServer } from "../src/mcp-server.js";

const memoryTools = [
  "memory_recall",
  "memory_remember",
  "memory_update",
  "memory_replace",
  "memory_forget",
  "memory_restore"
];

const coreAtomTools = [
  "atom_create",
  "atom_bulk_create",
  "atom_get",
  "atom_update",
  "atom_search",
  "atom_find_similar",
  "atom_context",
  "atom_delete",
  "atom_restore",
  "atom_link",
  "atom_unlink",
  "atom_neighbors",
  "atom_merge",
  "atom_feedback",
  "atom_supersede"
];

function build(profile: "balanced" | "full", exposeMaintenanceTools = false): string[] {
  const atoms = {} as AtomService;
  const database = { config: { toolProfile: profile, exposeMaintenanceTools } } as unknown as Database;
  const smartMemory = {} as SmartMemoryService;
  createMcpServer(atoms, database, undefined, smartMemory);
  return [...registeredTools];
}

beforeEach(() => { registeredTools.length = 0; });

describe("MCP tool profiles", () => {
  it("exposes only six compact memory tools in balanced mode", () => {
    expect(build("balanced")).toEqual(memoryTools);
  });

  it("restores all core atom tools in full mode", () => {
    expect(build("full")).toEqual([...memoryTools, ...coreAtomTools]);
  });

  it("does not expose maintenance tools in balanced mode even when enabled", () => {
    expect(build("balanced", true)).toEqual(memoryTools);
  });
});
