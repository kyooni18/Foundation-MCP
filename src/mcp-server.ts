import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AtomService } from "./atom-service.js";
import type { Database } from "./db.js";
import { ATOM_KINDS } from "./types.js";
import { jsonText } from "./utils.js";

const metadataSchema = z.record(z.string(), z.unknown());
const atomKindSchema = z.enum(ATOM_KINDS);
const atomStatusSchema = z.enum(["active", "archived", "deleted"]);

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
const searchSchema = z.object(searchShape);

function result(data: any) {
  return {
    content: [{ type: "text" as const, text: jsonText(data) }],
    structuredContent: data
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Foundation error: ${message}` }],
    isError: true
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

export function createMcpServer(atoms: AtomService, database: Database): McpServer {
  const server = new McpServer(
    { name: "foundation-mcp", version: "0.1.0" },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    "foundation_health",
    {
      title: "Foundation Health",
      description: "Check database connectivity, active atom count, and embedding configuration.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async () => ({
      ok: true,
      database: await database.health(),
      embedding: {
        provider: database.config.embeddingProvider,
        model: database.config.embeddingModel,
        dimensions: database.config.embeddingDimensions
      }
    }))
  );

  server.registerTool(
    "atom_create",
    {
      title: "Create Atom",
      description: "Store one durable, self-contained memory atom. Deduplicates normalized content within a namespace.",
      inputSchema: createSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async input => atoms.create(input))
  );

  server.registerTool(
    "atom_bulk_create",
    {
      title: "Create Atoms in Bulk",
      description: "Store up to 100 atoms. Each item reports success or failure independently.",
      inputSchema: z.object({ items: z.array(createSchema).min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async ({ items }) => atoms.bulkCreate(items))
  );

  server.registerTool(
    "atom_get",
    {
      title: "Get Atom",
      description: "Read a single atom by UUID.",
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id }) => ({ atom: await atoms.get(id) }))
  );

  server.registerTool(
    "atom_update",
    {
      title: "Update Atom",
      description: "Patch an atom. Recomputes its hash and embedding when content changes and increments its version.",
      inputSchema: z.object({
        id: z.string().uuid(),
        expectedVersion: z.number().int().min(1).optional().describe("Optimistic concurrency guard"),
        content: z.string().min(1).max(100_000).optional(),
        namespace: z.string().min(1).optional(),
        summary: z.string().max(2_000).nullable().optional(),
        kind: atomKindSchema.optional(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
        metadata: metadataSchema.optional(),
        source: metadataSchema.optional(),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    tool(async input => ({ atom: await atoms.update(input) }))
  );

  server.registerTool(
    "atom_search",
    {
      title: "Search Atoms",
      description: "Search atoms with hybrid semantic, full-text, trigram, importance, confidence, and recency ranking.",
      inputSchema: searchSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async input => atoms.search(input))
  );

  server.registerTool(
    "atom_find_similar",
    {
      title: "Find Similar Atoms",
      description: "Find likely duplicates or related atoms using an existing atom as the query.",
      inputSchema: z.object({
        id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10),
        mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async ({ id, limit, mode }) => atoms.similar(id, { limit, mode }))
  );

  server.registerTool(
    "atom_context",
    {
      title: "Build Memory Context",
      description: "Search atoms and pack the best matches into a compact context block bounded by character count.",
      inputSchema: z.object({
        ...searchShape,
        maxCharacters: z.number().int().min(256).max(50_000).default(8_000),
        includeMetadata: z.boolean().default(false)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async input => atoms.context(input))
  );

  server.registerTool(
    "atom_list",
    {
      title: "List Atoms",
      description: "Browse atoms with namespace, status, kind, and tag filters.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        statuses: z.array(atomStatusSchema).default(["active"]),
        kinds: z.array(atomKindSchema).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        sort: z.enum(["created", "updated", "importance"]).default("updated")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async input => atoms.list(input))
  );

  server.registerTool(
    "atom_delete",
    {
      title: "Delete or Archive Atom",
      description: "Archive, soft-delete, or permanently delete an atom. Hard deletion requires confirmation equal to the atom UUID.",
      inputSchema: z.object({
        id: z.string().uuid(),
        mode: z.enum(["archive", "delete", "hard"]).default("archive"),
        confirmation: z.string().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool(async ({ id, mode, confirmation }) => atoms.remove(id, mode, confirmation))
  );

  server.registerTool(
    "atom_restore",
    {
      title: "Restore Atom",
      description: "Restore an archived or soft-deleted atom to active status.",
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    tool(async ({ id }) => ({ atom: await atoms.restore(id) }))
  );

  server.registerTool(
    "atom_link",
    {
      title: "Link Atoms",
      description: "Create or update a directed typed relation between two atoms.",
      inputSchema: z.object({
        fromAtomID: z.string().uuid(),
        toAtomID: z.string().uuid(),
        relationType: z.string().min(1).max(100),
        weight: z.number().min(0).max(1).default(1),
        metadata: metadataSchema.default({})
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async input => ({ relation: await atoms.link(input) }))
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
        limit: z.number().int().min(1).max(200).default(50)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id, direction, relationTypes, limit }) => ({
      neighbors: await atoms.neighbors(id, direction, relationTypes, limit)
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
        summary: z.string().max(2_000).nullable().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    tool(async input => atoms.merge(input))
  );

  server.registerTool(
    "atom_reembed",
    {
      title: "Re-embed Atoms",
      description: "Generate embeddings for active atoms, normally only those missing embeddings. Intended for maintenance.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(1000).default(100),
        onlyMissing: z.boolean().default(true)
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    tool(async input => atoms.reembed(input))
  );

  server.registerTool(
    "atom_history",
    {
      title: "Atom History",
      description: "Read audit events for one atom, including creation, updates, links, merges, and removal.",
      inputSchema: z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ id, limit }) => ({ events: await atoms.history(id, limit) }))
  );

  server.registerTool(
    "atom_stats",
    {
      title: "Atom Statistics",
      description: "Return atom counts, embedding coverage, expiration counts, and kind distribution.",
      inputSchema: z.object({ namespace: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    tool(async ({ namespace }) => atoms.stats(namespace))
  );

  server.registerResource(
    "foundation-about",
    "foundation://about",
    {
      title: "Foundation MCP Atom Model",
      description: "Reference for namespaces, atom fields, ranking, and mutation behavior.",
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
          "Repeated normalized content is deduplicated within a namespace.",
          "Archive is the preferred reversible removal mode; hard deletion requires the atom UUID as confirmation.",
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
      description: "Current aggregate atom statistics.",
      mimeType: "application/json"
    },
    async (uri: URL) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: jsonText(await atoms.stats()) }]
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
            "Do not store secrets, transient chatter, or speculative inferences as facts.",
            "Preserve provenance in source and uncertainty in confidence.",
            "Prefer archive over hard deletion, and ask before destructive changes."
          ].join("\n")
        }
      }]
    })
  );

  return server;
}
