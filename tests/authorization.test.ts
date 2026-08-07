import { describe, expect, it, vi } from "vitest";
import type { AtomService } from "../src/atom-service.js";
import { authorizeToolNamespaces } from "../src/authorization.js";

function fakeAtoms(namespace = "private") {
  return {
    namespacesForIDs: vi.fn(async () => [namespace]),
    neighborNamespaces: vi.fn(async () => [namespace])
  } as unknown as AtomService;
}

describe("namespace authorization", () => {
  it("allows scoped searches only inside an allowed namespace", async () => {
    await expect(authorizeToolNamespaces(fakeAtoms(), "atom_search", { namespace: "project:calcite" }, ["project:*"])).resolves.toBeUndefined();
    await expect(authorizeToolNamespaces(fakeAtoms(), "atom_search", {}, ["project:*"])).rejects.toThrow(/explicit authorized namespace/);
  });

  it("checks both current and destination namespaces when moving an atom", async () => {
    await expect(authorizeToolNamespaces(fakeAtoms("private"), "atom_update", {
      id: "00000000-0000-0000-0000-000000000001",
      namespace: "project:calcite"
    }, ["project:*"])).rejects.toThrow(/private/);
  });

  it("requires all-namespace authority for global maintenance and diagnostics", async () => {
    for (const tool of ["foundation_health", "foundation_maintenance_run", "foundation_maintenance_status", "foundation_diagnostics"]) {
      await expect(authorizeToolNamespaces(fakeAtoms(), tool, {}, ["project:*"])).rejects.toThrow(/all namespaces/);
      await expect(authorizeToolNamespaces(fakeAtoms(), tool, {}, ["*"])).resolves.toBeUndefined();
    }
  });

});
