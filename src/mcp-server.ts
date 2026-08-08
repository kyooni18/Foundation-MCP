import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { modelAtom, STANDARD_RELATION_TYPES } from "./atom-service.js";
import type { AtomService } from "./atom-service.js";
import type { Database } from "./db.js";
import type { MaintenanceService } from "./maintenance.js";
import type { SmartMemoryService } from "./smart-memory.js";
import { ATOM_KINDS, ATOM_STATUSES } from "./types.js";
import { jsonText } from "./utils.js";

const metadataSchema = z.record(z.string(), z.unknown());
const atomKindSchema = z.enum(ATOM_KINDS);
const atomStatusSchema = z.enum(ATOM_STATUSES);
const detailsField = z.boolean().default(false).describe("Include internal fields and metadata; disabled by default for compact output");

const createShape = {
  content: z.string().min(1).max(100_000).describe("Atomic statement or compact note to store"),
  namespace: z.string().min(1).default("default").describe("Logical memory partition, such as personal, project:calcite, or work"),
  summary: z.string().max(2_000).nullable().optional(),
  kind: atomKindSchema.default("fact"),
  importance: z.number().min(0).max(1).default(0.5),
  confidence: z.number().min(0).max(1).default(1),
  tags: z.array(z.string().max(100)).max(100).default([]),
  metadata: metadataSchema.default({}),
  source: metadataSchema.default({}).describe("Provenance such as URL, message id, document id, author, or capture method"),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  dedupe: z.enum(["merge", "replace", "error"]).default("merge")
};
const createSchema = z.object(createShape);

const searchShape = {
  query: z.string().min(1).max(20_000),
  namespace: z.string().optional(),
  kinds: z.array(atomKindSchema).optional(),
  tagsAny: z.array(z.string().max(100)).max(100).optional(),
  tagsAll: z.array(z.string().max(100)).max(100).optional(),
  statuses: z.array(atomStatusSchema).default(["active"]),
  minImportance: z.number().min(0).max(1).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
  includeExpired: z.boolean().default(false),
  mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(10),
  semanticWeight: z.number().min(0).max(1).optional(),
  lexicalWeight: z.number().min(0).max(1).optional(),
  recencyHalfLifeDays: z.number().min(1).max(3650).default(180)
};
function result(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }]
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Foundation error: ${message.slice(0, 1_000)}` }],
    isError: true
  };
}

function registerOptionalTool(server: McpServer, enabled: boolean, name: string, config: any, handler: any): void {
  if (enabled) server.registerTool(name, config, handler);
}

function modelRelation(relation: any, includeMetadata = false): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: relation.id,
    from_atom_id: relation.from_atom_id,
    to_atom_id: relation.to_atom_id,
    relation_type: relation.relation_type,
    weight: relation.weight
  };
  if (includeMetadata) compact.metadata = relation.metadata;
  return compact;
}

function modelNeighbor(item: any, includeMetadata = false): Record<string, unknown> {
  return {
    relation: modelRelation(item.relation, includeMetadata),
    neighbor: modelAtom(item.neighbor, includeMetadata)
  };
}

function tool(
  handler: (input: any) => Promise<any>
): (input: any) => Promise<ReturnType<typeof result> | ReturnType<typeof failure>> {
  return async input => {
    try {
      return result(await handler(input));
    } catch (error) {
      return failure(error);
    }
  };
}

export function createMcpServer(atoms: AtomService, database: Database, maintenance?: MaintenanceService, smartMemory?: SmartMemoryService): McpServer {
  const server = new McpServer(
    { name: "foundation-mcp", version: "0.3.3" },
    { capabilities: { logging: {} } }
  );
  const exposeMaintenanceTools = database.config.exposeMaintenanceTools;

  if (smartMemory) {
    server.registerTool(
      "memory_recall",
      {
        title: "Recall Memory",
        description: "Recall and pack relevant active durable memories. Resolved, superseded, deprecated, archived, and deleted atoms are excluded by default. This path never invokes the smart LLM.",
        inputSchema: z.object({
          query: z.string().min(1).max(20_000),
          namespace: z.string().optional(),
          limit: z.number().int().min(1).max(50).default(8),
          maxCharacters: z.number().int().min(256).max(50_000).default(8_000),
          maxTokens: z.number().int().min(64).max(20_000).default(2_000)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      tool(input => smartMemory.recall(input))
    );

    server.registerTool(
      "memory_remember",
      {
        title: "Remember Memory",
        description: "Store durable memory with deterministic preprocessing first and at most one smart-model call for ambiguous writes or explicit lifecycle changes such as resolved or obsolete information.",
        inputSchema: z.object({
          text: z.string().min(1).max(100_000),
          namespace: z.string().optional(),
          tags: z.array(z.string().max(100)).max(100).default([]),
          source: metadataSchema.default({}),
          store: z.boolean().default(true).describe("Set false to inspect the planned write without mutating memory")
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      },
      tool(input => smartMemory.remember(input))
    );
  }

  registerOptionalTool(server, exposeMaintenanceTools,
    "foundation_health",
    {
      title: "Foundation Health",
      description: "Check database connectivity, active atom count, and embedding configuration.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async () => {
      const maintenanceState = maintenance ? await maintenance.status(1) : null;
      return {
        ok: true,
        database: await database.health(),
        embedding: atoms.embeddings.stats(),
        smartModel: smartMemory?.stats() ?? { enabled: false },
        maintenance: maintenanceState
          ? { enabled: true, running: maintenanceState.running, queued: maintenanceState.queued }
          : { enabled: false }
      };
    })
  );

  server.registerTool(
    "atom_create",
    {
      title: "Create Atom",
      description: "Store one durable, self-contained memory atom. Deduplicates normalized content within a namespace.",
      inputSchema: createSchema.extend({ includeDetails: detailsField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async input => {
      const { includeDetails, ...createInput } = input;
      const result = await atoms.create(createInput);
      return includeDetails ? result : {
        created: result.created,
        deduplicated: result.deduplicated,
        atom: modelAtom(result.atom)
      };
    })
  );

  server.registerTool(
    "atom_bulk_create",
    {
      title: "Create Atoms in Bulk",
      description: "Store up to 100 atoms. Each item reports success or failure independently.",
      inputSchema: z.object({ items: z.array(createSchema).min(1).max(100), atomic: z.boolean().default(false).describe("Rollback the entire batch if any item fails"), includeDetails: detailsField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async ({ items, atomic, includeDetails }) => {
      const result = await atoms.bulkCreate(items, { atomic });
      return includeDetails ? result : {
        results: result.results.map((item: any) => item.ok && item.atom
          ? { index: item.index, ok: true, created: item.created, deduplicated: item.deduplicated, atom: modelAtom(item.atom) }
          : item)
      };
    })
  );

  server.registerTool(
    "atom_get",
    {
      title: "Get Atom",
      description: "Read a single atom by UUID.",
      inputSchema: z.object({ id: z.string().uuid(), includeDetails: detailsField }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id, includeDetails }) => {
      const atom = await atoms.get(id);
      return { atom: includeDetails ? atom : modelAtom(atom) };
    })
  );

  server.registerTool(
    "atom_update",
    {
      title: "Update Atom",
      description: "Patch an atom, including its lifecycle status. Recomputes its hash and embedding when content changes and increments its version.",
      inputSchema: z.object({
        id: z.string().uuid(),
        expectedVersion: z.number().int().min(1).optional().describe("Optimistic concurrency guard"),
        content: z.string().min(1).max(100_000).optional(),
        namespace: z.string().min(1).optional(),
        summary: z.string().max(2_000).nullable().optional(),
        kind: atomKindSchema.optional(),
        status: atomStatusSchema.optional().describe("Lifecycle status. Recall/search defaults only include active atoms."),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
        metadata: metadataSchema.optional(),
        source: metadataSchema.optional(),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async input => {
      const { includeDetails, ...updateInput } = input;
      const atom = await atoms.update(updateInput);
      return { atom: includeDetails ? atom : modelAtom(atom) };
    })
  );

  server.registerTool(
    "atom_search",
    {
      title: "Search Atoms",
      description: "Search atoms with hybrid semantic, full-text, trigram, importance, confidence, and recency ranking. Active atoms are searched by default; pass statuses explicitly for history.",
      inputSchema: z.object({
        ...searchShape,
        includeDetails: z.boolean().default(false).describe("Include internal fields and metadata; disabled by default for compact model output")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async input => {
      const search = await atoms.search(input);
      return input.includeDetails
        ? search
        : { ...search, results: search.results.map(atom => modelAtom(atom)) };
    })
  );

  server.registerTool(
    "atom_find_similar",
    {
      title: "Find Similar Atoms",
      description: "Find likely duplicates or related active atoms using an existing atom as the query.",
      inputSchema: z.object({
        id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10),
        mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid"),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async ({ id, limit, mode, includeDetails }) => {
      const result = await atoms.similar(id, { limit, mode });
      return includeDetails ? result : {
        atom: modelAtom((result as any).atom),
        effectiveMode: result.effectiveMode,
        results: (result.results as any[]).map((atom: any) => modelAtom(atom))
      };
    })
  );

  server.registerTool(
    "atom_context",
    {
      title: "Build Memory Context",
      description: "Search, diversify, optionally expand relations, and pack the best memory context within character/token budgets.",
      inputSchema: z.object({
        ...searchShape,
        maxCharacters: z.number().int().min(256).max(50_000).default(8_000),
        maxTokens: z.number().int().min(64).max(20_000).optional().describe("Optional approximate token budget in addition to maxCharacters"),
        includeAtoms: z.boolean().default(false).describe("Include matching atom records in addition to the packed context; disabled by default to avoid duplication"),
        includeMetadata: z.boolean().default(false).describe("Include metadata and provenance when includeAtoms is enabled")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async input => atoms.context(input))
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_list",
    {
      title: "List Atoms",
      description: "Browse atoms with namespace, lifecycle status, kind, and tag filters.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        statuses: z.array(atomStatusSchema).default(["active"]),
        kinds: z.array(atomKindSchema).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        sort: z.enum(["created", "updated", "importance"]).default("updated"),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async input => {
      const { includeDetails, ...listInput } = input;
      const result = await atoms.list(listInput);
      return includeDetails ? result : { ...result, atoms: result.atoms.map(atom => modelAtom(atom)) };
    })
  );

  server.registerTool(
    "atom_delete",
    {
      title: "Delete or Archive Atom",
      description: "Archive, soft-delete, or permanently delete an atom. For completed or obsolete knowledge prefer atom_update with resolved/deprecated status. Hard deletion requires confirmation equal to the atom UUID.",
      inputSchema: z.object({
        id: z.string().uuid(),
        mode: z.enum(["archive", "delete", "hard"]).default("archive"),
        confirmation: z.string().optional(),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool(async ({ id, mode, confirmation, includeDetails }) => {
      const result = await atoms.remove(id, mode, confirmation);
      return includeDetails || !(result as any).atom ? result : { atom: modelAtom((result as any).atom) };
    })
  );

  server.registerTool(
    "atom_restore",
    {
      title: "Restore Atom",
      description: "Restore any non-active atom to active status.",
      inputSchema: z.object({ id: z.string().uuid(), includeDetails: detailsField }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    tool(async ({ id, includeDetails }) => {
      const atom = await atoms.restore(id);
      return { atom: includeDetails ? atom : modelAtom(atom) };
    })
  );

  server.registerTool(
    "atom_link",
    {
      title: "Link Atoms",
      description: `Create or update a directed typed relation between two atoms. Standard relation types include ${STANDARD_RELATION_TYPES.join(", ")}; custom types remain supported.`,
      inputSchema: z.object({
        fromAtomID: z.string().uuid(),
        toAtomID: z.string().uuid(),
        relationType: z.string().min(1).max(100),
        weight: z.number().min(0).max(1).default(1),
        metadata: metadataSchema.default({}),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async input => {
      const { includeDetails, ...linkInput } = input;
      const relation = await atoms.link(linkInput);
      return { relation: includeDetails ? relation : modelRelation(relation) };
    })
  );

  server.registerTool(
    "atom_unlink",
    {
      title: "Unlink Atoms",
      description: "Remove one directed typed relation between two atoms.",
      inputSchema: z.object({
        fromAtomID: z.string().uuid(),
        toAtomID: z.string().uuid(),
        relationType: z.string().min(1).max(100)
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool(async input => atoms.unlink(input))
  );

  server.registerTool(
    "atom_neighbors",
    {
      title: "Get Atom Neighbors",
      description: "Read atoms connected through incoming or outgoing typed relations.",
      inputSchema: z.object({
        id: z.string().uuid(),
        direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
        relationTypes: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id, direction, relationTypes, limit, includeDetails }) => ({
      neighbors: (await atoms.neighbors(id, direction, relationTypes, limit)).map(item => includeDetails ? item : modelNeighbor(item))
    }))
  );

  server.registerTool(
    "atom_merge",
    {
      title: "Merge Duplicate Atoms",
      description: "Merge multiple atoms into a target, combine tags and metadata, rewire relations, and archive source atoms.",
      inputSchema: z.object({
        targetAtomID: z.string().uuid(),
        sourceAtomIDs: z.array(z.string().uuid()).min(1).max(100),
        content: z.string().min(1).max(100_000).optional(),
        summary: z.string().max(2_000).nullable().optional(),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool(async input => {
      const { includeDetails, ...mergeInput } = input;
      const result = await atoms.merge(mergeInput);
      return includeDetails ? result : { atom: modelAtom(result.atom), mergedAtomIDs: result.mergedAtomIDs };
    })
  );

  server.registerTool(
    "atom_feedback",
    {
      title: "Record Atom Feedback",
      description: "Record whether a retrieved memory was useful, neutral, or misleading. Feedback is a bounded ranking signal and does not mutate the atom itself.",
      inputSchema: z.object({
        atomID: z.string().uuid(),
        signal: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
        reason: z.string().max(500).optional(),
        source: z.string().max(100).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    tool(async input => atoms.feedback(input))
  );

  server.registerTool(
    "atom_supersede",
    {
      title: "Supersede Atom",
      description: "Create a replacement atom, link it with a supersedes relation, and optionally mark the older atom as superseded atomically.",
      inputSchema: z.object({
        oldAtomID: z.string().uuid(),
        replacement: createSchema,
        archiveOld: z.boolean().default(true).describe("Compatibility field: when true, the older atom is retired with superseded status"),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    tool(async ({ includeDetails, ...input }) => {
      const result = await atoms.supersede(input);
      return includeDetails ? result : {
        oldAtom: modelAtom(result.oldAtom),
        replacementAtom: modelAtom(result.replacementAtom),
        relation: modelRelation(result.relation)
      };
    })
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_consolidate",
    {
      title: "Find and Link Near-Duplicate Atoms",
      description: "Scan a bounded active-memory window for strong near-duplicates and add duplicate_of suggestion relations without automatically merging or deleting data.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(2000).default(100),
        lexicalThreshold: z.number().min(0).max(1).default(0.9),
        semanticThreshold: z.number().min(0).max(1).default(0.965),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ includeDetails, ...input }) => {
      const result = await atoms.consolidate(input);
      return includeDetails ? result : { scannedPairs: result.scannedPairs, linked: result.linked };
    })
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_lifecycle_suggestions",
    {
      title: "Atom Lifecycle Suggestions",
      description: "Suggest bounded review, promotion, or decay candidates using age, access, importance, and explicit feedback. This never changes atoms automatically.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async input => atoms.lifecycleSuggestions(input))
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_reembed",
    {
      title: "Re-embed Atoms",
      description: "Generate embeddings for active atoms, normally only those missing embeddings. Intended for maintenance.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        onlyMissing: z.boolean().default(true),
        includeDetails: detailsField
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async ({ includeDetails, ...input }) => {
      const result = await atoms.reembed(input);
      return includeDetails
        ? result
        : { scanned: result.scanned, updated: result.updated, failed: Array.isArray(result.failures) ? result.failures.length : 0 };
    })
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_history",
    {
      title: "Atom History",
      description: "Read audit events for one atom, including creation, updates, links, merges, lifecycle changes, and removal.",
      inputSchema: z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50), includeDetails: detailsField }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id, limit, includeDetails }) => {
      const events = await atoms.history(id, limit);
      return { events: includeDetails ? events : events.map(({ details: _details, ...event }) => event) };
    })
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "atom_stats",
    {
      title: "Atom Statistics",
      description: "Return atom counts by lifecycle status, embedding coverage, expiration counts, and kind distribution.",
      inputSchema: z.object({ namespace: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ namespace }) => atoms.stats(namespace))
  );

  registerOptionalTool(server, exposeMaintenanceTools && Boolean(maintenance),
    "foundation_maintenance_run",
    {
      title: "Run Foundation Maintenance",
      description: "Run a bounded maintenance job for OAuth cleanup, stale embeddings, duplicate suggestions, expiration archival, or all enabled maintenance steps.",
      inputSchema: z.object({
        jobType: z.enum(["oauth_cleanup", "reembed", "consolidate", "archive_expired", "full"]).default("full")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async ({ jobType }) => maintenance!.enqueue(jobType, { requestedBy: "mcp" }))
  );

  registerOptionalTool(server, exposeMaintenanceTools && Boolean(maintenance),
    "foundation_maintenance_status",
    {
      title: "Foundation Maintenance Status",
      description: "Read recent maintenance job status.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ limit }) => maintenance!.status(limit))
  );

  registerOptionalTool(server, exposeMaintenanceTools,
    "foundation_diagnostics",
    {
      title: "Foundation Diagnostics",
      description: "Read schema, pool, index, embedding, and maintenance diagnostics without exposing atom contents.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async () => ({
      database: await database.health(),
      indexes: await database.indexHealth(),
      embedding: atoms.embeddings.stats(),
      smartModel: smartMemory?.stats() ?? { enabled: false },
      maintenance: maintenance ? await maintenance.status(10) : { enabled: false }
    }))
  );

  server.registerResource(
    "foundation-about",
    "foundation://about",
    {
      title: "Foundation MCP Atom Model",
      description: "Reference for namespaces, atom fields, ranking, lifecycle, and mutation behavior.",
      mimeType: "text/markdown"
    },
    async (uri: URL) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# Foundation MCP",
          "",
          "Atoms are durable, self-contained pieces of knowledge partitioned by namespace.",
          "Search combines semantic similarity, exact/lexical similarity, importance, confidence, and recency.",
          "Repeated normalized content is deduplicated within a namespace without automatically reactivating retired memory.",
          "Lifecycle statuses are active, resolved, superseded, deprecated, archived, and deleted. Normal recall only uses active atoms.",
          "Use resolved for completed problems/tasks, superseded when a newer atom replaces an older one, and deprecated for obsolete knowledge.",
          "Archive is the generic reversible removal mode; hard deletion requires the atom UUID as confirmation.",
          "Relations are directed and typed. Use atom_neighbors to traverse them."
        ].join("\n")
      }]
    })
  );

  server.registerResource(
    "foundation-stats",
    "foundation://stats",
    {
      title: "Foundation Statistics",
      description: "Current aggregate atom statistics plus smart-model usage counters when smart memory is available.",
      mimeType: "application/json"
    },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: jsonText({ ...(await atoms.stats()), smartModel: smartMemory?.stats() ?? { enabled: false } }) }]
    })
  );

  server.registerPrompt(
    "foundation-memory-policy",
    {
      title: "Foundation Memory Policy",
      description: "A conservative workflow for searching and writing durable memories.",
      argsSchema: { namespace: z.string().default("default") }
    },
    ({ namespace }: { namespace: string }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Use Foundation namespace '${namespace}' conservatively.`,
            "Search before claiming prior knowledge.",
            "Store only durable, self-contained facts, preferences, decisions, constraints, or reusable procedures.",
            "When information is explicitly fixed, completed, replaced, or obsolete, retire the older atom with the appropriate lifecycle status instead of leaving it active.",
            "Do not store secrets, transient chatter, or speculative inferences as facts.",
            "Preserve provenance in source and uncertainty in confidence.",
            "Prefer reversible lifecycle changes or archive over hard deletion, and ask before destructive changes."
          ].join("\n")
        }
      }]
    })
  );

  return server;
}
