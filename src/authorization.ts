import type { AtomService } from "./atom-service.js";
import { namespaceMatches, normalizeNamespace } from "./utils.js";

const GLOBAL_TOOLS = new Set<string>();

export function allNamespacesAllowed(patterns: string[]): boolean {
  return patterns.includes("*");
}

export function assertNamespacesAllowed(namespaces: string[], patterns: string[]): void {
  const denied = [...new Set(namespaces)].filter(namespace => !namespaceMatches(namespace, patterns));
  if (denied.length) throw new Error(`Credential is not authorized for namespace: ${denied.slice(0, 3).join(", ")}`);
}

export async function authorizeToolNamespaces(
  atoms: AtomService,
  toolName: string,
  args: Record<string, unknown>,
  patterns: string[]
): Promise<void> {
  if (allNamespacesAllowed(patterns) || GLOBAL_TOOLS.has(toolName)) return;

  const explicitNamespace = typeof args.namespace === "string" ? normalizeNamespace(args.namespace) : null;
  const explicitlyScopedQueryTools = new Set([
    "atom_search", "atom_context", "atom_list", "atom_stats", "atom_reembed", "atom_consolidate", "atom_lifecycle_suggestions", "memory_recall"
  ]);
  if (explicitNamespace && explicitlyScopedQueryTools.has(toolName)) {
    assertNamespacesAllowed([explicitNamespace], patterns);
    return;
  }

  if (toolName === "memory_remember") {
    assertNamespacesAllowed([typeof args.namespace === "string" ? normalizeNamespace(args.namespace) : "default"], patterns);
    return;
  }
  if (toolName === "atom_create") {
    assertNamespacesAllowed([typeof args.namespace === "string" ? normalizeNamespace(args.namespace) : "default"], patterns);
    return;
  }
  if (toolName === "atom_bulk_create") {
    const items = Array.isArray(args.items) ? args.items : [];
    const namespaces = items.map(item => {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return typeof record.namespace === "string" ? normalizeNamespace(record.namespace) : "default";
    });
    assertNamespacesAllowed(namespaces, patterns);
    return;
  }
  if (toolName === "atom_supersede") {
    const replacement = args.replacement && typeof args.replacement === "object" ? args.replacement as Record<string, unknown> : {};
    const ids = typeof args.oldAtomID === "string" ? [args.oldAtomID] : [];
    const namespaces = await atoms.namespacesForIDs(ids);
    namespaces.push(typeof replacement.namespace === "string" ? normalizeNamespace(replacement.namespace) : "default");
    assertNamespacesAllowed(namespaces, patterns);
    return;
  }
  if (["atom_get", "atom_update", "atom_delete", "atom_restore", "atom_find_similar", "atom_history", "atom_feedback",
      "memory_update", "memory_replace", "memory_forget", "memory_restore"].includes(toolName)) {
    const id = typeof args.id === "string" ? args.id : typeof args.atomID === "string" ? args.atomID : null;
    if (!id) throw new Error("Unable to determine atom namespace for authorization");
    const namespaces = await atoms.namespacesForIDs([id]);
    if (toolName === "atom_update" && explicitNamespace) namespaces.push(explicitNamespace);
    assertNamespacesAllowed(namespaces, patterns);
    return;
  }
  if (toolName === "atom_neighbors") {
    const id = typeof args.id === "string" ? args.id : null;
    if (!id) throw new Error("Unable to determine atom namespace for authorization");
    assertNamespacesAllowed(await atoms.neighborNamespaces(id), patterns);
    return;
  }
  if (["atom_link", "atom_unlink"].includes(toolName)) {
    const ids = [args.fromAtomID, args.toAtomID].filter((value): value is string => typeof value === "string");
    assertNamespacesAllowed(await atoms.namespacesForIDs(ids), patterns);
    return;
  }
  if (toolName === "atom_merge") {
    const ids = [args.targetAtomID, ...(Array.isArray(args.sourceAtomIDs) ? args.sourceAtomIDs : [])]
      .filter((value): value is string => typeof value === "string");
    assertNamespacesAllowed(await atoms.namespacesForIDs(ids), patterns);
    return;
  }

  if (["foundation_health", "foundation_maintenance_run", "foundation_maintenance_status", "foundation_diagnostics"].includes(toolName)) {
    throw new Error("Global health, maintenance, and diagnostics require a credential authorized for all namespaces");
  }

  // Queries without an explicit namespace can enumerate all namespaces, so a restricted credential must scope them.
  if (["atom_search", "atom_context", "atom_list", "atom_stats", "atom_reembed", "atom_consolidate", "atom_lifecycle_suggestions", "memory_recall"].includes(toolName)) {
    throw new Error("Restricted credentials must provide an explicit authorized namespace for this tool");
  }
}
