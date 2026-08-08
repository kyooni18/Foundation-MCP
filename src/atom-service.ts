import type { PoolClient, QueryResultRow } from "pg";
import type { Database } from "./db.js";
import type { EmbeddingService, EmbeddingResult } from "./embeddings.js";
import type {
  AtomCreateInput,
  AtomRow,
  AtomSearchInput,
  AtomStatus,
  AtomUpdateInput,
  RelationRow,
  SearchResult
} from "./types.js";
import { decomposeQuery, diversifyCandidates, packContext, type ContextCandidate } from "./context-planner.js";
import { metrics } from "./telemetry.js";
import {
  clamp,
  compactRecord,
  boundedRecord,
  normalizeContent,
  normalizeNamespace,
  normalizeOptionalText,
  normalizeTags,
  parseOptionalDate,
  sha256,
  vectorLiteral
} from "./utils.js";

interface SearchResponse {
  query: string;
  requestedMode: string;
  effectiveMode: string;
  results: SearchResult[];
}

interface PreparedCreate {
  content: string;
  namespace: string;
  hash: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source: Record<string, unknown>;
  summary: string | null;
  expiresAt: Date | null;
  kind: AtomCreateInput["kind"];
  importance: number;
  confidence: number;
  dedupe: NonNullable<AtomCreateInput["dedupe"]>;
}

export const STANDARD_RELATION_TYPES = [
  "related_to",
  "supports",
  "contradicts",
  "supersedes",
  "derived_from",
  "duplicate_of"
] as const;

function atomFromRow(row: QueryResultRow): AtomRow {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    content: String(row.content),
    normalized_content: String(row.normalized_content),
    content_hash: String(row.content_hash),
    summary: row.summary === null ? null : String(row.summary),
    kind: row.kind,
    status: row.status,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    metadata: compactRecord(row.metadata),
    source: compactRecord(row.source),
    embedding_provider: row.embedding_provider === null ? null : String(row.embedding_provider),
    embedding_model: row.embedding_model === null ? null : String(row.embedding_model),
    embedding_dimensions: row.embedding_dimensions === null ? null : Number(row.embedding_dimensions),
    version: Number(row.version),
    access_count: Number(row.access_count),
    last_accessed_at: row.last_accessed_at ? new Date(row.last_accessed_at) : null,
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}

function searchFromRow(row: QueryResultRow): SearchResult {
  return {
    ...atomFromRow(row),
    semantic_score: Number(row.semantic_score ?? 0),
    lexical_score: Number(row.lexical_score ?? 0),
    recency_score: Number(row.recency_score ?? 0),
    access_score: Number(row.access_score ?? 0),
    feedback_score: Number(row.feedback_score ?? 0),
    score: Number(row.score ?? 0)
  };
}

export function modelAtom(atom: AtomRow | SearchResult, includeMetadata = false): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    id: atom.id,
    namespace: atom.namespace,
    kind: atom.kind,
    status: atom.status,
    content: atom.content,
    summary: atom.summary,
    tags: atom.tags
  };
  if ("score" in atom) {
    compact.score = atom.score;
    compact.semantic_score = atom.semantic_score;
    compact.lexical_score = atom.lexical_score;
  }
  if (includeMetadata) {
    compact.metadata = atom.metadata;
    compact.source = atom.source;
  }
  return compact;
}

function relationFromRow(row: QueryResultRow): RelationRow {
  return {
    id: String(row.id),
    from_atom_id: String(row.from_atom_id),
    to_atom_id: String(row.to_atom_id),
    relation_type: String(row.relation_type),
    weight: Number(row.weight),
    metadata: compactRecord(row.metadata),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}

export class AtomService {
  constructor(
    private readonly database: Database,
    readonly embeddings: EmbeddingService
  ) {}

  validateCreate(input: AtomCreateInput): void {
    this.prepareCreate(input);
  }

  async create(input: AtomCreateInput): Promise<{ atom: AtomRow; created: boolean; deduplicated: boolean }> {
    const prepared = this.prepareCreate(input);
    const duplicate = await this.database.query("SELECT id FROM atoms WHERE namespace=$1 AND content_hash=$2 LIMIT 1", [prepared.namespace, prepared.hash]);
    if (duplicate.rows[0] && prepared.dedupe === "error") throw new Error("An atom with the same normalized content already exists in this namespace");

    // Exact duplicates can be merged/replaced without paying for another embedding request.
    const embedding = duplicate.rows[0] ? null : await this.embeddings.embed(prepared.content);
    return this.database.transaction(client => this.createPrepared(client, prepared, embedding));
  }

  async bulkCreate(items: AtomCreateInput[], options: { atomic?: boolean } = {}): Promise<{ results: Array<Record<string, unknown>>; atomic?: boolean }> {
    if (items.length < 1 || items.length > 100) throw new Error("items must contain between 1 and 100 atoms");

    if (options.atomic) {
      const prepared = items.map(item => this.prepareCreate(item));
      const existing = await this.database.query<{ namespace: string; content_hash: string }>(
        `SELECT namespace,content_hash FROM atoms
         WHERE (namespace,content_hash) IN (SELECT * FROM unnest($1::text[],$2::char(64)[]))`,
        [prepared.map(item => item.namespace), prepared.map(item => item.hash)]
      );
      const existingKeys = new Set(existing.rows.map(row => `${row.namespace}\u0000${row.content_hash}`));
      const duplicateError = prepared.find(item => item.dedupe === "error" && existingKeys.has(`${item.namespace}\u0000${item.hash}`));
      if (duplicateError) throw new Error("An atom with the same normalized content already exists in this namespace");

      const toEmbed = prepared.map((item, index) => ({ item, index }))
        .filter(entry => !existingKeys.has(`${entry.item.namespace}\u0000${entry.item.hash}`));
      const embedded = await this.embeddings.embedMany(toEmbed.map(entry => entry.item.content));
      const embeddingByIndex = new Map<number, EmbeddingResult | null>();
      toEmbed.forEach((entry, position) => embeddingByIndex.set(entry.index, embedded[position] ?? null));

      const results = await this.database.transaction(async client => {
        const created: Array<Record<string, unknown>> = [];
        for (let index = 0; index < prepared.length; index += 1) {
          const result = await this.createPrepared(client, prepared[index]!, embeddingByIndex.get(index) ?? null);
          created.push({ index, ok: true, ...result });
        }
        return created;
      });
      return { results, atomic: true };
    }

    // Preserve per-item partial success while still batching embedding requests.
    // Invalid inputs never prevent valid siblings from being processed.
    const prepared: Array<PreparedCreate | null> = [];
    const results: Array<Record<string, unknown> | undefined> = new Array(items.length);
    for (let index = 0; index < items.length; index += 1) {
      try {
        prepared[index] = this.prepareCreate(items[index]!);
      } catch (error) {
        prepared[index] = null;
        results[index] = { index, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const valid = prepared.map((item, index) => item ? { item, index } : null).filter((value): value is { item: PreparedCreate; index: number } => value !== null);
    const existingKeys = new Set<string>();
    if (valid.length) {
      const namespaces = valid.map(entry => entry.item.namespace);
      const hashes = valid.map(entry => entry.item.hash);
      const existing = await this.database.query<{ namespace: string; content_hash: string }>(
        `SELECT namespace,content_hash FROM atoms
         WHERE (namespace,content_hash) IN (SELECT * FROM unnest($1::text[],$2::char(64)[]))`,
        [namespaces, hashes]
      );
      for (const row of existing.rows) existingKeys.add(`${row.namespace}\u0000${row.content_hash}`);
    }

    const embedEntries = valid.filter(entry => !existingKeys.has(`${entry.item.namespace}\u0000${entry.item.hash}`));
    const embeddingByIndex = new Map<number, EmbeddingResult | null>();
    if (embedEntries.length) {
      try {
        const batch = await this.embeddings.embedMany(embedEntries.map(entry => entry.item.content));
        embedEntries.forEach((entry, position) => embeddingByIndex.set(entry.index, batch[position] ?? null));
      } catch {
        // A provider can reject a single malformed/oversized item. Fall back to
        // per-item embedding so one failure does not change the legacy partial-success semantics.
        for (const entry of embedEntries) {
          try {
            embeddingByIndex.set(entry.index, await this.embeddings.embed(entry.item.content));
          } catch (error) {
            results[entry.index] = { index: entry.index, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
      }
    }

    for (const entry of valid) {
      if (results[entry.index]) continue;
      try {
        if (existingKeys.has(`${entry.item.namespace}\u0000${entry.item.hash}`) && entry.item.dedupe === "error") {
          throw new Error("An atom with the same normalized content already exists in this namespace");
        }
        const result = await this.database.transaction(client => this.createPrepared(client, entry.item, embeddingByIndex.get(entry.index) ?? null));
        results[entry.index] = { index: entry.index, ok: true, ...result };
      } catch (error) {
        results[entry.index] = { index: entry.index, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { results: results.map((item, index) => item ?? ({ index, ok: false, error: "Unknown bulk-create failure" })) };
  }

  async get(id: string): Promise<AtomRow> {
    const result = await this.database.query("SELECT * FROM atoms WHERE id = $1", [id]);
    if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
    return atomFromRow(result.rows[0]);
  }

  async namespacesForIDs(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const result = await this.database.query<{ namespace: string }>("SELECT DISTINCT namespace FROM atoms WHERE id = ANY($1::uuid[])", [unique]);
    return result.rows.map(row => String(row.namespace));
  }

  async neighborNamespaces(id: string): Promise<string[]> {
    const result = await this.database.query<{ namespace: string }>(
      `SELECT DISTINCT a.namespace
       FROM atom_relations r
       JOIN atoms a ON a.id = CASE WHEN r.from_atom_id=$1 THEN r.to_atom_id ELSE r.from_atom_id END
       WHERE r.from_atom_id=$1 OR r.to_atom_id=$1
       UNION SELECT namespace FROM atoms WHERE id=$1`,
      [id]
    );
    return result.rows.map(row => String(row.namespace));
  }

  async update(input: AtomUpdateInput): Promise<AtomRow> {
    const requestedContent = input.content === undefined ? undefined : normalizeContent(input.content);
    if (requestedContent !== undefined && !requestedContent) throw new Error("content must not be empty");
    if (requestedContent && requestedContent.length > 100_000) throw new Error("content exceeds 100000 characters");
    const preparedEmbedding = requestedContent === undefined ? null : await this.embeddings.embed(requestedContent);

    return this.database.transaction(async client => {
      const currentResult = await client.query("SELECT * FROM atoms WHERE id=$1 FOR UPDATE", [input.id]);
      if (!currentResult.rows[0]) throw new Error(`Atom not found: ${input.id}`);
      const current = atomFromRow(currentResult.rows[0]);
      if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw new Error(`Version conflict: expected ${input.expectedVersion}, current ${current.version}`);
      }
      const content = requestedContent ?? current.content;
      const namespace = input.namespace === undefined ? current.namespace : normalizeNamespace(input.namespace);
      const summary = input.summary === undefined ? current.summary : normalizeOptionalText(input.summary, "summary", 2_000);
      const metadata = input.metadata === undefined ? current.metadata : boundedRecord(input.metadata, "metadata");
      const source = input.source === undefined ? current.source : boundedRecord(input.source, "source");
      const contentChanged = content !== current.normalized_content;
      const expiresAt = parseOptionalDate(input.expiresAt, "expiresAt");
      const embedding = contentChanged ? preparedEmbedding : null;

      const result = await client.query(
        `
        UPDATE atoms SET
          namespace = $2,
          content = $3,
          normalized_content = $3,
          content_hash = $4,
          summary = $5,
          kind = $6,
          status = $7,
          importance = $8,
          confidence = $9,
          tags = $10,
          metadata = $11::jsonb,
          source = $12::jsonb,
          expires_at = $13,
          embedding = CASE WHEN $14::boolean THEN $15::vector ELSE embedding END,
          embedding_provider = CASE WHEN $14::boolean THEN $16 ELSE embedding_provider END,
          embedding_model = CASE WHEN $14::boolean THEN $17 ELSE embedding_model END,
          embedding_dimensions = CASE WHEN $14::boolean THEN $18 ELSE embedding_dimensions END,
          version = version + 1
        WHERE id = $1
        RETURNING *
        `,
        [
          input.id, namespace, content, sha256(content), summary,
          input.kind ?? current.kind,
          input.status ?? current.status,
          clamp(input.importance ?? current.importance),
          clamp(input.confidence ?? current.confidence),
          input.tags === undefined ? current.tags : normalizeTags(input.tags),
          JSON.stringify(metadata), JSON.stringify(source),
          expiresAt === undefined ? current.expires_at : expiresAt,
          contentChanged,
          this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null
        ]
      );
      const atom = atomFromRow(result.rows[0]!);
      await this.database.auditWith(client, "update", atom.id, { fields: Object.keys(input).filter(key => key !== "id") });
      return atom;
    });
  }

  async search(input: AtomSearchInput): Promise<SearchResponse> {
    const query = normalizeContent(input.query);
    if (!query) throw new Error("query must not be empty");
    if (query.length > 20_000) throw new Error("query exceeds 20000 characters");
    const requestedMode = input.mode ?? "hybrid";
    const embedding = requestedMode === "lexical" ? null : await this.embeddings.embed(query);
    const effectiveMode = embedding ? requestedMode : "lexical";
    const semanticEnabled = effectiveMode !== "lexical" && embedding !== null;
    const lexicalEnabled = effectiveMode !== "semantic";
    const semanticWeight = semanticEnabled ? clamp(input.semanticWeight ?? (requestedMode === "semantic" ? 1 : 0.65)) : 0;
    const lexicalWeight = lexicalEnabled ? clamp(input.lexicalWeight ?? 0.35) : 0;
    const combinedWeight = semanticWeight + lexicalWeight || 1;
    const halfLife = Math.max(1, input.recencyHalfLifeDays ?? 180);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const candidateLimit = Math.min(2_000, Math.max(200, limit * 24));
    const params: unknown[] = [];
    const add = (value: unknown): string => { params.push(value); return `$${params.length}`; };

    const queryRef = add(query);
    const vectorRef = add(this.vectorOrNull(embedding));
    const providerRef = add(embedding?.provider ?? null);
    const modelRef = add(embedding?.model ?? null);
    const dimensionRef = add(embedding?.dimensions ?? this.database.config.embeddingDimensions);
    const semanticEnabledRef = add(semanticEnabled);
    const lexicalEnabledRef = add(lexicalEnabled);
    const semanticWeightRef = add(semanticWeight / combinedWeight);
    const lexicalWeightRef = add(lexicalWeight / combinedWeight);
    const halfLifeRef = add(halfLife);
    const accessWeightRef = add(this.database.config.adaptiveAccessWeight);
    const feedbackWeightRef = add(this.database.config.adaptiveFeedbackWeight);
    const conditions = ["a.status = ANY(" + add(input.statuses ?? ["active"]) + "::text[])"];

    if (input.namespace) conditions.push(`a.namespace = ${add(normalizeNamespace(input.namespace))}`);
    if (input.kinds?.length) conditions.push(`a.kind = ANY(${add(input.kinds)}::text[])`);
    if (input.tagsAny?.length) conditions.push(`a.tags && ${add(normalizeTags(input.tagsAny))}::text[]`);
    if (input.tagsAll?.length) conditions.push(`a.tags @> ${add(normalizeTags(input.tagsAll))}::text[]`);
    if (input.minImportance !== undefined) conditions.push(`a.importance >= ${add(clamp(input.minImportance))}`);
    if (input.minConfidence !== undefined) conditions.push(`a.confidence >= ${add(clamp(input.minConfidence))}`);
    if (input.createdAfter) conditions.push(`a.created_at >= ${add(new Date(input.createdAfter))}`);
    if (input.createdBefore) conditions.push(`a.created_at <= ${add(new Date(input.createdBefore))}`);
    if (!input.includeExpired) conditions.push("(a.expires_at IS NULL OR a.expires_at > NOW())");
    const candidateLimitRef = add(candidateLimit);
    const limitRef = add(limit);
    const dimensions = this.database.config.embeddingDimensions;

    const started = process.hrtime.bigint();
    const result = await this.database.query(
      `
      WITH filtered AS NOT MATERIALIZED (
        SELECT a.*
        FROM atoms a
        WHERE ${conditions.join(" AND ")}
      ), semantic_candidates AS (
        SELECT id,
          row_number() OVER (ORDER BY embedding::vector(${dimensions}) <=> ${vectorRef}::vector(${dimensions}))::double precision AS semantic_rank
        FROM filtered
        WHERE ${semanticEnabledRef}::boolean
          AND ${vectorRef}::vector IS NOT NULL
          AND embedding IS NOT NULL
          AND embedding_provider = ${providerRef}
          AND embedding_model = ${modelRef}
          AND embedding_dimensions = ${dimensionRef}
        ORDER BY embedding::vector(${dimensions}) <=> ${vectorRef}::vector(${dimensions})
        LIMIT ${candidateLimitRef}
      ), lexical_candidates AS (
        SELECT id,
          row_number() OVER (ORDER BY GREATEST(
            LEAST(1, ts_rank_cd(search_document, websearch_to_tsquery('simple', ${queryRef})) * 4),
            similarity(content, ${queryRef})
          ) DESC)::double precision AS lexical_rank
        FROM filtered
        WHERE ${lexicalEnabledRef}::boolean
          AND (
            search_document @@ websearch_to_tsquery('simple', ${queryRef})
            OR content % ${queryRef}
            OR content ILIKE '%' || ${queryRef} || '%'
          )
        ORDER BY GREATEST(
          LEAST(1, ts_rank_cd(search_document, websearch_to_tsquery('simple', ${queryRef})) * 4),
          similarity(content, ${queryRef})
        ) DESC
        LIMIT ${candidateLimitRef}
      ), candidate_ids AS (
        SELECT id, min(semantic_rank) AS semantic_rank, min(lexical_rank) AS lexical_rank
        FROM (
          SELECT id, semantic_rank, NULL::double precision AS lexical_rank FROM semantic_candidates
          UNION ALL
          SELECT id, NULL::double precision AS semantic_rank, lexical_rank FROM lexical_candidates
        ) candidates
        GROUP BY id
      ), ranked AS (
        SELECT
          a.*,
          CASE
            WHEN NOT ${semanticEnabledRef}::boolean
              OR ${vectorRef}::vector IS NULL
              OR a.embedding IS NULL
              OR a.embedding_provider IS DISTINCT FROM ${providerRef}
              OR a.embedding_model IS DISTINCT FROM ${modelRef}
              OR a.embedding_dimensions IS DISTINCT FROM ${dimensionRef}
            THEN 0::double precision
            ELSE GREATEST(0, 1 - (a.embedding::vector(${dimensions}) <=> ${vectorRef}::vector(${dimensions})))
          END AS semantic_score,
          CASE WHEN ${lexicalEnabledRef}::boolean THEN GREATEST(
            LEAST(1, ts_rank_cd(a.search_document, websearch_to_tsquery('simple', ${queryRef})) * 4),
            similarity(a.content, ${queryRef})
          ) ELSE 0::double precision END AS lexical_score,
          EXP(-GREATEST(EXTRACT(EPOCH FROM (NOW() - a.updated_at)) / 86400.0, 0) / ${halfLifeRef}) AS recency_score,
          CASE WHEN a.access_count <= 0 OR a.last_accessed_at IS NULL THEN 0::double precision ELSE
            LEAST(1, LN(1 + a.access_count::double precision) / LN(101.0)) *
            EXP(-GREATEST(EXTRACT(EPOCH FROM (NOW() - a.last_accessed_at)) / 86400.0, 0) / 365.0)
          END AS access_score,
          COALESCE(f.feedback_score, 0)::double precision AS feedback_score,
          COALESCE(1.0 / (60.0 + c.semantic_rank), 0) + COALESCE(1.0 / (60.0 + c.lexical_rank), 0) AS reciprocal_rank_score
        FROM filtered a
        JOIN candidate_ids c ON c.id = a.id
        LEFT JOIN LATERAL (
          SELECT LEAST(1, GREATEST(-1, COALESCE(avg(signal)::double precision, 0))) AS feedback_score
          FROM atom_feedback
          WHERE atom_id = a.id AND created_at >= NOW() - INTERVAL '365 days'
        ) f ON TRUE
      ), scored AS (
        SELECT ranked.*,
          (
            ${semanticWeightRef} * semantic_score +
            ${lexicalWeightRef} * lexical_score +
            0.05 * LEAST(1, reciprocal_rank_score * 30) +
            0.08 * importance +
            0.04 * confidence +
            0.03 * recency_score +
            ${accessWeightRef} * access_score +
            ${feedbackWeightRef} * feedback_score
          ) AS score
        FROM ranked
      )
      SELECT * FROM scored
      WHERE semantic_score > 0 OR lexical_score > 0
      ORDER BY score DESC, updated_at DESC, id
      LIMIT ${limitRef}
      `,
      params
    );
    metrics.observe("search", Number(process.hrtime.bigint() - started) / 1e9);
    metrics.increment("search_requests_total");
    metrics.increment(`search_mode_${effectiveMode}_total`);
    return { query, requestedMode, effectiveMode, results: result.rows.map(searchFromRow) };
  }

  async similar(id: string, options: { limit?: number; mode?: "hybrid" | "semantic" | "lexical" } = {}): Promise<Record<string, unknown>> {
    const atom = await this.get(id);
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const search = await this.search({
      query: atom.content,
      namespace: atom.namespace,
      statuses: ["active"],
      includeExpired: false,
      mode: options.mode ?? "hybrid",
      limit: Math.min(100, limit + 1)
    });
    return {
      atom,
      effectiveMode: search.effectiveMode,
      results: search.results.filter(candidate => candidate.id !== id).slice(0, limit)
    };
  }

  async list(options: {
    namespace?: string;
    statuses?: AtomStatus[];
    kinds?: string[];
    tags?: string[];
    limit?: number;
    offset?: number;
    sort?: "created" | "updated" | "importance";
  }): Promise<{ atoms: AtomRow[]; limit: number; offset: number }> {
    const params: unknown[] = [];
    const add = (value: unknown): string => { params.push(value); return `$${params.length}`; };
    const conditions = [`status = ANY(${add(options.statuses ?? ["active"])}::text[])`];
    if (options.namespace) conditions.push(`namespace = ${add(normalizeNamespace(options.namespace))}`);
    if (options.kinds?.length) conditions.push(`kind = ANY(${add(options.kinds)}::text[])`);
    if (options.tags?.length) conditions.push(`tags @> ${add(normalizeTags(options.tags))}::text[]`);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, options.offset ?? 0);
    const order = options.sort === "created" ? "created_at DESC" : options.sort === "importance" ? "importance DESC, updated_at DESC" : "updated_at DESC";
    const result = await this.database.query(
      `SELECT * FROM atoms WHERE ${conditions.join(" AND ")} ORDER BY ${order}, id LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params
    );
    return { atoms: result.rows.map(atomFromRow), limit, offset };
  }

  async remove(id: string, mode: "archive" | "delete" | "hard", confirmation?: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async client => {
      if (mode === "hard") {
        if (confirmation !== id) throw new Error("Hard deletion requires confirmation equal to the atom id");
        const result = await client.query("DELETE FROM atoms WHERE id = $1 RETURNING id", [id]);
        if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
        await this.database.auditWith(client, "hard-delete", null, { id });
        return { id, status: "hard-deleted" };
      }
      const status = mode === "archive" ? "archived" : "deleted";
      const result = await client.query(
        "UPDATE atoms SET status = $2, version = version + 1 WHERE id = $1 RETURNING *",
        [id, status]
      );
      if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
      await this.database.auditWith(client, mode, id);
      return { atom: atomFromRow(result.rows[0]) };
    });
  }

  async restore(id: string): Promise<AtomRow> {
    return this.database.transaction(async client => {
      const result = await client.query(
        "UPDATE atoms SET status = 'active', version = version + 1 WHERE id = $1 RETURNING *",
        [id]
      );
      if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
      await this.database.auditWith(client, "restore", id);
      return atomFromRow(result.rows[0]);
    });
  }

  async link(input: {
    fromAtomID: string;
    toAtomID: string;
    relationType: string;
    weight?: number;
    metadata?: Record<string, unknown>;
  }): Promise<RelationRow> {
    if (input.fromAtomID === input.toAtomID) throw new Error("An atom cannot link to itself");
    const relationType = this.normalizeRelationType(input.relationType);
    const metadata = boundedRecord(input.metadata, "relation metadata");
    return this.database.transaction(async client => {
      const result = await client.query(
        `
        INSERT INTO atom_relations (from_atom_id, to_atom_id, relation_type, weight, metadata)
        VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (from_atom_id, to_atom_id, relation_type) DO UPDATE SET
          weight = EXCLUDED.weight,
          metadata = atom_relations.metadata || EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *
        `,
        [input.fromAtomID, input.toAtomID, relationType, clamp(input.weight ?? 1), JSON.stringify(metadata)]
      );
      await this.database.auditWith(client, "link", input.fromAtomID, { to: input.toAtomID, relationType });
      return relationFromRow(result.rows[0]!);
    });
  }

  async unlink(input: { fromAtomID: string; toAtomID: string; relationType: string }): Promise<Record<string, unknown>> {
    const relationType = this.normalizeRelationType(input.relationType);
    return this.database.transaction(async client => {
      const result = await client.query(
        `DELETE FROM atom_relations
         WHERE from_atom_id = $1 AND to_atom_id = $2 AND relation_type = $3
         RETURNING id`,
        [input.fromAtomID, input.toAtomID, relationType]
      );
      if (!result.rows[0]) throw new Error("Relation not found");
      await this.database.auditWith(client, "unlink", input.fromAtomID, { to: input.toAtomID, relationType });
      return { removed: true, relationID: String(result.rows[0].id) };
    });
  }

  async neighbors(id: string, direction: "outgoing" | "incoming" | "both" = "both", relationTypes?: string[], limit = 50): Promise<Array<Record<string, unknown>>> {
    const params: unknown[] = [id];
    const directionCondition = direction === "outgoing"
      ? "r.from_atom_id = $1"
      : direction === "incoming"
        ? "r.to_atom_id = $1"
        : "(r.from_atom_id = $1 OR r.to_atom_id = $1)";
    let typeCondition = "";
    if (relationTypes?.length) {
      params.push(relationTypes.map(value => this.normalizeRelationType(value)));
      typeCondition = `AND r.relation_type = ANY($${params.length}::text[])`;
    }
    params.push(Math.max(1, Math.min(limit, 200)));
    const result = await this.database.query(
      `
      SELECT
        r.*,
        CASE WHEN r.from_atom_id = $1 THEN r.to_atom_id ELSE r.from_atom_id END AS neighbor_id,
        a.namespace AS neighbor_namespace,
        a.content AS neighbor_content,
        a.normalized_content AS neighbor_normalized_content,
        a.content_hash AS neighbor_content_hash,
        a.summary AS neighbor_summary,
        a.kind AS neighbor_kind,
        a.status AS neighbor_status,
        a.importance AS neighbor_importance,
        a.confidence AS neighbor_confidence,
        a.tags AS neighbor_tags,
        a.metadata AS neighbor_metadata,
        a.source AS neighbor_source,
        a.embedding_provider AS neighbor_embedding_provider,
        a.embedding_model AS neighbor_embedding_model,
        a.embedding_dimensions AS neighbor_embedding_dimensions,
        a.version AS neighbor_version,
        a.access_count AS neighbor_access_count,
        a.last_accessed_at AS neighbor_last_accessed_at,
        a.expires_at AS neighbor_expires_at,
        a.created_at AS neighbor_created_at,
        a.updated_at AS neighbor_updated_at
      FROM atom_relations r
      JOIN atoms a ON a.id = CASE WHEN r.from_atom_id = $1 THEN r.to_atom_id ELSE r.from_atom_id END
      WHERE ${directionCondition} ${typeCondition}
      ORDER BY r.weight DESC, r.updated_at DESC
      LIMIT $${params.length}
      `,
      params
    );
    return result.rows.map(row => ({
      relation: relationFromRow(row),
      neighbor: this.neighborAtomFromRow(row)
    }));
  }

  async merge(input: {
    targetAtomID: string;
    sourceAtomIDs: string[];
    content?: string;
    summary?: string | null;
  }): Promise<{ atom: AtomRow; mergedAtomIDs: string[] }> {
    const sourceIDs = [...new Set(input.sourceAtomIDs)].filter(id => id !== input.targetAtomID);
    if (!sourceIDs.length) throw new Error("sourceAtomIDs must contain at least one atom different from targetAtomID");
    const requestedContent = input.content === undefined ? undefined : normalizeContent(input.content);
    if (requestedContent !== undefined && !requestedContent) throw new Error("content must not be empty");
    const requestedSummary = normalizeOptionalText(input.summary, "summary", 2_000);
    const preparedEmbedding = requestedContent === undefined ? null : await this.embeddings.embed(requestedContent);
    const merged = await this.database.transaction(async client => {
      const rows = await client.query("SELECT * FROM atoms WHERE id = ANY($1::uuid[]) FOR UPDATE", [[input.targetAtomID, ...sourceIDs]]);
      if (rows.rows.length !== sourceIDs.length + 1) throw new Error("One or more atoms were not found");
      const atoms = rows.rows.map(atomFromRow);
      const target = atoms.find(atom => atom.id === input.targetAtomID)!;
      const content = requestedContent ?? target.content;
      const tags = normalizeTags(atoms.flatMap(atom => atom.tags));
      const sourceAtoms = atoms.filter(atom => atom.id !== target.id);
      const metadata = boundedRecord(Object.assign({}, ...sourceAtoms.map(atom => atom.metadata), target.metadata), "metadata");
      const source = boundedRecord({
        ...target.source,
        merged_from: sourceAtoms.map(atom => ({ id: atom.id, source: atom.source }))
      }, "source");
      const importance = Math.max(...atoms.map(atom => atom.importance));
      const confidence = Math.max(...atoms.map(atom => atom.confidence));
      const contentChanged = requestedContent !== undefined && content !== target.normalized_content;
      const embedding = preparedEmbedding;

      const updated = await client.query(
        `
        UPDATE atoms SET
          content=$2, normalized_content=$2, content_hash=$3, summary=$4, tags=$5,
          metadata=$6::jsonb, source=$7::jsonb, importance=$8, confidence=$9,
          embedding=CASE WHEN $10::boolean THEN $11::vector ELSE embedding END,
          embedding_provider=CASE WHEN $10::boolean THEN $12 ELSE embedding_provider END,
          embedding_model=CASE WHEN $10::boolean THEN $13 ELSE embedding_model END,
          embedding_dimensions=CASE WHEN $10::boolean THEN $14 ELSE embedding_dimensions END,
          status='active', version=version+1
        WHERE id=$1 RETURNING *
        `,
        [
          target.id, content, sha256(content), requestedSummary === undefined ? target.summary : requestedSummary,
          tags, JSON.stringify(metadata), JSON.stringify(source), importance, confidence,
          contentChanged, this.vectorOrNull(embedding), embedding?.provider ?? null,
          embedding?.model ?? null, embedding?.dimensions ?? null
        ]
      );

      await this.rewireRelations(client, target.id, sourceIDs);
      await client.query("UPDATE atoms SET status='archived', version=version+1 WHERE id = ANY($1::uuid[])", [sourceIDs]);
      const atom = atomFromRow(updated.rows[0]!);
      await this.database.auditWith(client, "merge", atom.id, { sourceIDs });
      return atom;
    });
    return { atom: merged, mergedAtomIDs: sourceIDs };
  }

  async supersede(input: {
    oldAtomID: string;
    replacement: AtomCreateInput;
    archiveOld?: boolean;
  }): Promise<{ oldAtom: AtomRow; replacementAtom: AtomRow; relation: RelationRow }> {
    const prepared = this.prepareCreate(input.replacement);
    const duplicate = await this.database.query("SELECT id FROM atoms WHERE namespace=$1 AND content_hash=$2 LIMIT 1", [prepared.namespace, prepared.hash]);
    if (duplicate.rows[0] && prepared.dedupe === "error") throw new Error("An atom with the same normalized content already exists in this namespace");
    const embedding = duplicate.rows[0] ? null : await this.embeddings.embed(prepared.content);
    return this.database.transaction(async client => {
      const oldResult = await client.query("SELECT * FROM atoms WHERE id=$1 FOR UPDATE", [input.oldAtomID]);
      if (!oldResult.rows[0]) throw new Error(`Atom not found: ${input.oldAtomID}`);
      const oldAtom = atomFromRow(oldResult.rows[0]);
      const created = await this.createPrepared(client, prepared, embedding);
      if (created.atom.id === oldAtom.id) throw new Error("Replacement atom resolves to the same atom as oldAtomID");
      const relationResult = await client.query(
        `INSERT INTO atom_relations (from_atom_id,to_atom_id,relation_type,weight,metadata)
         VALUES ($1,$2,'supersedes',1,'{"managed_by":"atom_supersede"}'::jsonb)
         ON CONFLICT (from_atom_id,to_atom_id,relation_type) DO UPDATE SET weight=1, updated_at=NOW()
         RETURNING *`,
        [created.atom.id, oldAtom.id]
      );
      if (input.archiveOld ?? true) {
        await client.query("UPDATE atoms SET status='superseded', version=version+1 WHERE id=$1", [oldAtom.id]);
      }
      await this.database.auditWith(client, "supersede", created.atom.id, { oldAtomID: oldAtom.id, retired: input.archiveOld ?? true });
      const refreshedOld = await client.query("SELECT * FROM atoms WHERE id=$1", [oldAtom.id]);
      return {
        oldAtom: atomFromRow(refreshedOld.rows[0]!),
        replacementAtom: created.atom,
        relation: relationFromRow(relationResult.rows[0]!)
      };
    });
  }

  async context(input: AtomSearchInput & {
    maxCharacters?: number;
    maxTokens?: number;
    includeAtoms?: boolean;
    includeMetadata?: boolean;
  }): Promise<Record<string, unknown>> {
    const requestedLimit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const overfetch = Math.min(100, Math.max(20, requestedLimit * 4));
    const query = normalizeContent(input.query);
    const parts = this.database.config.contextQueryDecomposition ? decomposeQuery(query) : [];
    const queries = [query, ...parts];
    const searches = await Promise.all(queries.map(part => this.search({ ...input, query: part, limit: overfetch })));
    const merged = new Map<string, { atom: SearchResult; hits: number }>();
    for (const search of searches) {
      for (const atom of search.results) {
        const existing = merged.get(atom.id);
        if (!existing) merged.set(atom.id, { atom: { ...atom }, hits: 1 });
        else {
          existing.hits += 1;
          if (atom.score > existing.atom.score) existing.atom = { ...atom };
        }
      }
    }
    const candidates = [...merged.values()].map(({ atom, hits }) => ({
      ...atom,
      score: atom.score + Math.min(0.08, Math.max(0, hits - 1) * 0.025)
    })) as ContextCandidate[];

    const seeds = diversifyCandidates(candidates, requestedLimit, this.database.config.contextDiversityLambda);
    if (this.database.config.contextRelationExpansion && this.database.config.contextRelationLimit > 0 && seeds.length) {
      const related = await this.contextRelations(seeds, this.database.config.contextRelationLimit);
      const seen = new Set(candidates.map(atom => atom.id));
      for (const atom of related) {
        if (!seen.has(atom.id)) {
          candidates.push(atom);
          seen.add(atom.id);
        }
      }
    }

    const maxCharacters = Math.max(256, Math.min(input.maxCharacters ?? 8_000, 50_000));
    const maxTokens = input.maxTokens === undefined ? undefined : Math.max(64, Math.min(input.maxTokens, 20_000));
    const packed = packContext({
      candidates,
      maxCharacters,
      maxTokens,
      maxAtoms: requestedLimit,
      diversityLambda: this.database.config.contextDiversityLambda
    });
    await this.recordAccess(packed.selected.map(atom => atom.id));

    const response: Record<string, unknown> = {
      query,
      effectiveMode: searches[0]?.effectiveMode ?? "lexical",
      context: packed.lines.join("\n"),
      atomCount: packed.selected.length,
      characters: packed.characters,
      estimatedTokens: packed.estimatedTokens
    };
    if (parts.length) response.queryParts = parts;
    if (input.includeAtoms || input.includeMetadata) {
      response.atoms = packed.selected.map(atom => modelAtom(atom, input.includeMetadata));
    }
    return response;
  }

  async feedback(input: { atomID: string; signal: -1 | 0 | 1; reason?: string; source?: string }): Promise<Record<string, unknown>> {
    const reason = input.reason === undefined ? null : normalizeOptionalText(input.reason, "reason", 500) ?? null;
    const source = normalizeOptionalText(input.source, "source", 100) ?? "explicit";
    return this.database.transaction(async client => {
      const exists = await client.query("SELECT id FROM atoms WHERE id=$1", [input.atomID]);
      if (!exists.rows[0]) throw new Error(`Atom not found: ${input.atomID}`);
      const result = await client.query(
        `INSERT INTO atom_feedback (atom_id,signal,reason,source) VALUES ($1,$2,$3,$4)
         RETURNING id,atom_id,signal,reason,source,created_at`,
        [input.atomID, input.signal, reason, source]
      );
      await this.database.auditWith(client, "feedback", input.atomID, { signal: input.signal, source });
      return { feedback: result.rows[0] };
    });
  }

  async reembed(options: { namespace?: string; limit?: number; onlyMissing?: boolean }): Promise<Record<string, unknown>> {
    if (!this.embeddings.enabled) throw new Error("Embedding provider is disabled");
    const params: unknown[] = [];
    const conditions = ["status = 'active'"];
    if (options.namespace) { params.push(normalizeNamespace(options.namespace)); conditions.push(`namespace = $${params.length}`); }
    if (options.onlyMissing ?? true) {
      conditions.push("embedding IS NULL");
    } else {
      params.push(this.database.config.embeddingProvider, this.database.config.embeddingModel, this.database.config.embeddingDimensions);
      conditions.push(`(embedding IS NULL OR embedding_provider IS DISTINCT FROM $${params.length - 2} OR embedding_model IS DISTINCT FROM $${params.length - 1} OR embedding_dimensions IS DISTINCT FROM $${params.length})`);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 100, 5_000)));
    const rows = await this.database.query(`SELECT id, content FROM atoms WHERE ${conditions.join(" AND ")} ORDER BY updated_at ASC LIMIT $${params.length}`, params);
    let updated = 0;
    const failures: Array<Record<string, unknown>> = [];

    for (let offset = 0; offset < rows.rows.length; offset += this.database.config.embeddingBatchSize) {
      const batch = rows.rows.slice(offset, offset + this.database.config.embeddingBatchSize);
      try {
        const embeddings = await this.embeddings.embedMany(batch.map(row => String(row.content)));
        await this.database.transaction(async client => {
          const batchIDs: string[] = [];
          for (let index = 0; index < batch.length; index += 1) {
            const embedding = embeddings[index];
            if (!embedding) continue;
            const row = batch[index]!;
            await client.query(
              "UPDATE atoms SET embedding=$2::vector, embedding_provider=$3, embedding_model=$4, embedding_dimensions=$5 WHERE id=$1",
              [row.id, vectorLiteral(embedding.vector), embedding.provider, embedding.model, embedding.dimensions]
            );
            batchIDs.push(String(row.id));
          }
          if (batchIDs.length) await this.database.auditWith(client, "reembed", null, { atomIDs: batchIDs, updated: batchIDs.length });
          updated += batchIDs.length;
        });
      } catch (error) {
        for (const row of batch) failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.length) await this.database.audit("reembed-failures", null, { failures: failures.length });
    return { scanned: rows.rows.length, updated, failures };
  }

  async consolidate(options: { namespace?: string; limit?: number; lexicalThreshold?: number; semanticThreshold?: number } = {}): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 2_000));
    const lexicalThreshold = clamp(options.lexicalThreshold ?? 0.9);
    const semanticThreshold = clamp(options.semanticThreshold ?? 0.965);
    const params: unknown[] = [];
    const conditions = ["status='active'", "(expires_at IS NULL OR expires_at > NOW())"];
    if (options.namespace) {
      params.push(normalizeNamespace(options.namespace));
      conditions.push(`namespace=$${params.length}`);
    }
    // The lexical branch stays bounded; the semantic branch uses a small KNN
    // neighborhood for every seed instead of comparing every embedded pair.
    params.push(Math.min(1_500, Math.max(200, limit * 8)));
    const seedLimitRef = `$${params.length}`;
    const candidateLexicalThreshold = Math.max(0.30, lexicalThreshold - 0.35);
    params.push(candidateLexicalThreshold, lexicalThreshold, semanticThreshold, limit);
    const candidateLexicalRef = `$${params.length - 3}`;
    const lexicalRef = `$${params.length - 2}`;
    const semanticRef = `$${params.length - 1}`;
    const limitRef = `$${params.length}`;
    const dimensions = this.database.config.embeddingDimensions;

    const result = await this.database.query(
      `WITH seed AS MATERIALIZED (
        SELECT * FROM atoms WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ${seedLimitRef}
      ), lexical_pair_ids AS (
        SELECT DISTINCT
          CASE WHEN a.id < neighbor.id THEN a.id ELSE neighbor.id END AS a_id,
          CASE WHEN a.id < neighbor.id THEN neighbor.id ELSE a.id END AS b_id
        FROM seed a
        JOIN LATERAL (
          SELECT b.id
          FROM atoms b
          WHERE b.id<>a.id
            AND b.namespace=a.namespace
            AND b.status='active'
            AND (b.expires_at IS NULL OR b.expires_at>NOW())
            AND b.content_hash<>a.content_hash
            AND b.content % a.content
            AND similarity(b.content,a.content) >= ${candidateLexicalRef}
          ORDER BY similarity(b.content,a.content) DESC
          LIMIT 6
        ) neighbor ON TRUE
      ), semantic_pair_ids AS (
        SELECT DISTINCT
          CASE WHEN a.id < neighbor.id THEN a.id ELSE neighbor.id END AS a_id,
          CASE WHEN a.id < neighbor.id THEN neighbor.id ELSE a.id END AS b_id
        FROM seed a
        JOIN LATERAL (
          SELECT b.id
          FROM atoms b
          WHERE a.embedding IS NOT NULL
            AND a.embedding_dimensions=${dimensions}
            AND b.id<>a.id
            AND b.namespace=a.namespace
            AND b.status='active'
            AND (b.expires_at IS NULL OR b.expires_at>NOW())
            AND b.embedding IS NOT NULL
            AND b.embedding_provider=a.embedding_provider
            AND b.embedding_model=a.embedding_model
            AND b.embedding_dimensions=a.embedding_dimensions
          ORDER BY b.embedding::vector(${dimensions}) <=> a.embedding::vector(${dimensions})
          LIMIT 6
        ) neighbor ON TRUE
      ), pair_ids AS (
        SELECT a_id,b_id FROM lexical_pair_ids
        UNION
        SELECT a_id,b_id FROM semantic_pair_ids
      ), pairs AS (
        SELECT
          a.id AS a_id,b.id AS b_id,a.namespace,
          similarity(a.content,b.content)::double precision AS lexical_similarity,
          CASE WHEN a.embedding IS NOT NULL AND b.embedding IS NOT NULL
            AND a.embedding_provider=b.embedding_provider
            AND a.embedding_model=b.embedding_model
            AND a.embedding_dimensions=b.embedding_dimensions
            AND a.embedding_dimensions=${dimensions}
          THEN GREATEST(0,1-(a.embedding::vector(${dimensions}) <=> b.embedding::vector(${dimensions})))
          ELSE 0::double precision END AS semantic_similarity,
          a.importance AS a_importance,b.importance AS b_importance,
          a.confidence AS a_confidence,b.confidence AS b_confidence,
          a.created_at AS a_created_at,b.created_at AS b_created_at
        FROM pair_ids p
        JOIN atoms a ON a.id=p.a_id
        JOIN atoms b ON b.id=p.b_id
        WHERE a.namespace=b.namespace AND a.content_hash<>b.content_hash
      )
      SELECT * FROM pairs
      WHERE lexical_similarity >= ${lexicalRef} OR semantic_similarity >= ${semanticRef}
      ORDER BY GREATEST(lexical_similarity,semantic_similarity) DESC
      LIMIT ${limitRef}`,
      params
    );

    let linked = 0;
    const candidates: Array<Record<string, unknown>> = [];
    await this.database.transaction(async client => {
      for (const row of result.rows) {
        const aRank = Number(row.a_importance) + Number(row.a_confidence) * 0.25;
        const bRank = Number(row.b_importance) + Number(row.b_confidence) * 0.25;
        const canonical = aRank > bRank || (aRank === bRank && new Date(row.a_created_at) <= new Date(row.b_created_at)) ? String(row.a_id) : String(row.b_id);
        const duplicate = canonical === String(row.a_id) ? String(row.b_id) : String(row.a_id);
        const metadata = {
          auto_suggestion: true,
          lexical_similarity: Number(row.lexical_similarity),
          semantic_similarity: Number(row.semantic_similarity)
        };
        await client.query(
          `INSERT INTO atom_relations (from_atom_id,to_atom_id,relation_type,weight,metadata)
           VALUES ($1,$2,'duplicate_of',$3,$4::jsonb)
           ON CONFLICT (from_atom_id,to_atom_id,relation_type) DO UPDATE SET
             weight=GREATEST(atom_relations.weight,EXCLUDED.weight),metadata=atom_relations.metadata||EXCLUDED.metadata,updated_at=NOW()`,
          [duplicate,canonical,clamp(Math.max(Number(row.lexical_similarity),Number(row.semantic_similarity))),JSON.stringify(metadata)]
        );
        linked += 1;
        candidates.push({ duplicateAtomID: duplicate,canonicalAtomID: canonical,...metadata });
      }
      await this.database.auditWith(client,"consolidation-scan",null,{ linked,namespace: options.namespace ?? null });
    });
    return { scannedPairs: result.rows.length,linked,candidates };
  }

  async archiveExpired(limit = 1_000): Promise<Record<string, unknown>> {
    const bounded = Math.max(1, Math.min(limit, 10_000));
    return this.database.transaction(async client => {
      const result = await client.query(
        `WITH expired AS (
          SELECT id FROM atoms WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW()
          ORDER BY expires_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
        )
        UPDATE atoms SET status='archived', version=version+1
        WHERE id IN (SELECT id FROM expired) RETURNING id`,
        [bounded]
      );
      await this.database.auditWith(client, "archive-expired", null, { archived: result.rowCount ?? 0 });
      return { archived: result.rowCount ?? 0, atomIDs: result.rows.map(row => String(row.id)) };
    });
  }

  async lifecycleSuggestions(options: { namespace?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    const params: unknown[] = [];
    const conditions = ["a.status='active'", "(a.expires_at IS NULL OR a.expires_at > NOW())"];
    if (options.namespace) {
      params.push(normalizeNamespace(options.namespace));
      conditions.push(`a.namespace=$${params.length}`);
    }
    params.push(Math.max(1, Math.min(options.limit ?? 100, 500)));
    const limitRef = `$${params.length}`;
    const result = await this.database.query(
      `WITH scored AS (
        SELECT a.id,a.namespace,a.kind,a.content,a.summary,a.importance,a.confidence,a.access_count,a.last_accessed_at,a.updated_at,
          COALESCE((SELECT avg(f.signal)::double precision FROM atom_feedback f WHERE f.atom_id=a.id AND f.created_at >= NOW()-INTERVAL '365 days'),0) AS feedback,
          EXTRACT(EPOCH FROM (NOW()-a.updated_at))/86400.0 AS age_days
        FROM atoms a WHERE ${conditions.join(" AND ")}
      ), suggestions AS (
        SELECT *, CASE
          WHEN feedback <= -0.35 THEN 'review'
          WHEN access_count >= 5 AND last_accessed_at >= NOW()-INTERVAL '90 days' AND importance < 0.8 THEN 'promote'
          WHEN age_days >= 180 AND access_count <= 1 AND feedback <= 0 AND importance < 0.7 THEN 'decay'
          ELSE NULL END AS suggestion,
          CASE
            WHEN feedback <= -0.35 THEN LEAST(1,ABS(feedback))
            WHEN access_count >= 5 AND last_accessed_at >= NOW()-INTERVAL '90 days' AND importance < 0.8 THEN LEAST(1,LN(1+access_count::double precision)/LN(101.0))
            WHEN age_days >= 180 AND access_count <= 1 AND feedback <= 0 AND importance < 0.7 THEN LEAST(1,age_days/730.0)
            ELSE 0 END AS suggestion_score
        FROM scored
      )
      SELECT * FROM suggestions WHERE suggestion IS NOT NULL
      ORDER BY suggestion_score DESC, updated_at ASC LIMIT ${limitRef}`,
      params
    );
    return {
      suggestions: result.rows.map(row => ({
        atomID: String(row.id), namespace: String(row.namespace), kind: String(row.kind),
        content: String(row.content), summary: row.summary === null ? null : String(row.summary),
        suggestion: String(row.suggestion), score: Number(row.suggestion_score),
        importance: Number(row.importance), confidence: Number(row.confidence),
        accessCount: Number(row.access_count), feedback: Number(row.feedback), ageDays: Number(row.age_days)
      }))
    };
  }

  async history(id: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `
      SELECT id, operation, atom_id, details, created_at
      FROM atom_events
      WHERE atom_id = $1::uuid OR details->>'id' = $1::text
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [id, Math.max(1, Math.min(limit, 200))]
    );
    return result.rows.map(row => ({
      id: Number(row.id),
      operation: row.operation,
      atom_id: row.atom_id,
      details: compactRecord(row.details),
      created_at: new Date(row.created_at)
    }));
  }

  async stats(namespace?: string): Promise<Record<string, unknown>> {
    const normalizedNamespace = namespace ? normalizeNamespace(namespace) : null;
    const params = normalizedNamespace ? [normalizedNamespace] : [];
    const condition = namespace ? "WHERE namespace = $1" : "";
    const result = await this.database.query(
      `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status='active')::int AS active,
        count(*) FILTER (WHERE status='resolved')::int AS resolved,
        count(*) FILTER (WHERE status='superseded')::int AS superseded,
        count(*) FILTER (WHERE status='deprecated')::int AS deprecated,
        count(*) FILTER (WHERE status='archived')::int AS archived,
        count(*) FILTER (WHERE status='deleted')::int AS deleted,
        count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
        count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
        COALESCE(avg(importance), 0)::double precision AS average_importance,
        COALESCE(avg(confidence), 0)::double precision AS average_confidence,
        COALESCE(avg(access_count), 0)::double precision AS average_access_count,
        min(created_at) AS oldest_created_at,
        max(updated_at) AS latest_updated_at
      FROM atoms ${condition}
      `,
      params
    );
    const kinds = await this.database.query(
      `SELECT kind, count(*)::int AS count FROM atoms ${condition} GROUP BY kind ORDER BY count DESC`,
      params
    );
    const feedbackCondition = normalizedNamespace ? "JOIN atoms a ON a.id=f.atom_id WHERE a.namespace=$1" : "";
    const feedback = await this.database.query(
      `SELECT count(*)::int AS count, COALESCE(avg(signal),0)::double precision AS average_signal FROM atom_feedback f ${feedbackCondition}`,
      params
    );
    return { namespace: normalizedNamespace, ...result.rows[0], feedback: feedback.rows[0], kinds: kinds.rows };
  }

  private prepareCreate(input: AtomCreateInput): PreparedCreate {
    const content = normalizeContent(input.content);
    if (!content) throw new Error("content must not be empty");
    if (content.length > 100_000) throw new Error("content exceeds 100000 characters");
    return {
      content,
      namespace: normalizeNamespace(input.namespace ?? "default"),
      hash: sha256(content),
      tags: normalizeTags(input.tags),
      metadata: boundedRecord(input.metadata, "metadata"),
      source: boundedRecord(input.source, "source"),
      summary: normalizeOptionalText(input.summary, "summary", 2_000) ?? null,
      expiresAt: parseOptionalDate(input.expiresAt, "expiresAt") ?? null,
      kind: input.kind ?? "fact",
      importance: clamp(input.importance ?? 0.5),
      confidence: clamp(input.confidence ?? 1),
      dedupe: input.dedupe ?? "merge"
    };
  }

  private async createPrepared(client: PoolClient, input: PreparedCreate, embedding: EmbeddingResult | null): Promise<{ atom: AtomRow; created: boolean; deduplicated: boolean }> {
    if (input.dedupe === "error") {
      const result = await client.query(
        `INSERT INTO atoms (
          namespace, content, normalized_content, content_hash, summary, kind, importance, confidence,
          tags, metadata, source, expires_at, embedding, embedding_provider, embedding_model, embedding_dimensions
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::vector,$14,$15,$16)
        RETURNING *`,
        [
          input.namespace, input.content, input.content, input.hash, input.summary, input.kind,
          input.importance, input.confidence, input.tags, JSON.stringify(input.metadata), JSON.stringify(input.source), input.expiresAt,
          this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null
        ]
      );
      const atom = atomFromRow(result.rows[0]!);
      await this.database.auditWith(client, "create", atom.id, { namespace: input.namespace });
      return { atom, created: true, deduplicated: false };
    }

    const replace = input.dedupe === "replace";
    const result = await client.query(
      `INSERT INTO atoms (
        namespace, content, normalized_content, content_hash, summary, kind, importance, confidence,
        tags, metadata, source, expires_at, embedding, embedding_provider, embedding_model, embedding_dimensions
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::vector,$14,$15,$16)
      ON CONFLICT (namespace, content_hash) DO UPDATE SET
        content = EXCLUDED.content,
        normalized_content = EXCLUDED.normalized_content,
        summary = CASE WHEN $17::boolean THEN EXCLUDED.summary ELSE COALESCE(EXCLUDED.summary, atoms.summary) END,
        kind = CASE WHEN $17::boolean THEN EXCLUDED.kind ELSE atoms.kind END,
        importance = CASE WHEN $17::boolean THEN EXCLUDED.importance ELSE GREATEST(atoms.importance, EXCLUDED.importance) END,
        confidence = CASE WHEN $17::boolean THEN EXCLUDED.confidence ELSE GREATEST(atoms.confidence, EXCLUDED.confidence) END,
        tags = CASE WHEN $17::boolean THEN EXCLUDED.tags ELSE ARRAY(SELECT DISTINCT unnest(atoms.tags || EXCLUDED.tags) ORDER BY 1) END,
        metadata = CASE WHEN $17::boolean THEN EXCLUDED.metadata ELSE atoms.metadata || EXCLUDED.metadata END,
        source = CASE WHEN $17::boolean THEN EXCLUDED.source ELSE atoms.source || EXCLUDED.source END,
        expires_at = CASE WHEN $17::boolean THEN EXCLUDED.expires_at ELSE COALESCE(EXCLUDED.expires_at, atoms.expires_at) END,
        embedding = COALESCE(EXCLUDED.embedding, atoms.embedding),
        embedding_provider = COALESCE(EXCLUDED.embedding_provider, atoms.embedding_provider),
        embedding_model = COALESCE(EXCLUDED.embedding_model, atoms.embedding_model),
        embedding_dimensions = COALESCE(EXCLUDED.embedding_dimensions, atoms.embedding_dimensions),
        status = CASE WHEN $17::boolean THEN 'active' ELSE atoms.status END,
        version = atoms.version + 1
      RETURNING *, (xmax = 0) AS was_inserted`,
      [
        input.namespace, input.content, input.content, input.hash, input.summary, input.kind,
        input.importance, input.confidence, input.tags, JSON.stringify(input.metadata), JSON.stringify(input.source), input.expiresAt,
        this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null,
        replace
      ]
    );
    const row = result.rows[0]!;
    const atom = atomFromRow(row);
    const created = Boolean(row.was_inserted);
    await this.database.auditWith(client, created ? "create" : "deduplicate", atom.id, { namespace: input.namespace, mode: input.dedupe });
    return { atom, created, deduplicated: !created };
  }

  private normalizeRelationType(value: string): string {
    const relationType = normalizeContent(value).toLocaleLowerCase("und").replace(/\s+/g, "_");
    if (!relationType) throw new Error("relationType must not be empty");
    if (relationType.length > 100) throw new Error("relationType exceeds 100 characters");
    // Preserve the v0.1 contract for arbitrary relation strings. Standard
    // relation types are additive conventions, not aliases that rewrite a
    // caller's existing custom relation names.
    return relationType;
  }

  private vectorOrNull(embedding: EmbeddingResult | null): string | null {
    return embedding ? vectorLiteral(embedding.vector) : null;
  }

  private async recordAccess(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (!unique.length) return;
    try {
      await this.database.query(
        "UPDATE atoms SET access_count=access_count+1, last_accessed_at=NOW() WHERE id=ANY($1::uuid[])",
        [unique]
      );
      metrics.increment("atoms_accessed_total", unique.length);
    } catch {
      metrics.increment("atom_access_update_errors_total");
      // Retrieval must not fail solely because adaptive bookkeeping failed.
    }
  }

  private async contextRelations(seeds: SearchResult[], perSeed: number): Promise<ContextCandidate[]> {
    const seedMap = new Map(seeds.map(atom => [atom.id, atom]));
    const ids = [...seedMap.keys()];
    const result = await this.database.query(
      `WITH ranked_relations AS (
        SELECT r.*,
          CASE WHEN r.from_atom_id=ANY($1::uuid[]) THEN r.from_atom_id ELSE r.to_atom_id END AS seed_id,
          CASE WHEN r.from_atom_id=ANY($1::uuid[]) THEN r.to_atom_id ELSE r.from_atom_id END AS neighbor_id,
          row_number() OVER (
            PARTITION BY CASE WHEN r.from_atom_id=ANY($1::uuid[]) THEN r.from_atom_id ELSE r.to_atom_id END
            ORDER BY r.weight DESC, r.updated_at DESC
          ) AS position
        FROM atom_relations r
        WHERE (r.from_atom_id=ANY($1::uuid[]) OR r.to_atom_id=ANY($1::uuid[]))
          AND r.weight >= 0.65
      )
      SELECT a.*, r.seed_id, r.relation_type, r.weight AS relation_weight
      FROM ranked_relations r
      JOIN atoms a ON a.id=r.neighbor_id
      JOIN atoms seed ON seed.id=r.seed_id
      WHERE r.position <= $2
        AND a.status='active'
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
        AND a.namespace=seed.namespace
      ORDER BY r.weight DESC`,
      [ids, perSeed]
    );
    return result.rows.map(row => {
      const seed = seedMap.get(String(row.seed_id));
      const atom = atomFromRow(row);
      return {
        ...atom,
        semantic_score: 0,
        lexical_score: 0,
        recency_score: 0,
        access_score: 0,
        feedback_score: 0,
        score: (seed?.score ?? 0.5) * Number(row.relation_weight ?? 0) * 0.72,
        relation_score: Number(row.relation_weight ?? 0),
        relation_type: String(row.relation_type),
        seed_id: String(row.seed_id)
      };
    });
  }

  private neighborAtomFromRow(row: QueryResultRow): AtomRow {
    return {
      id: String(row.neighbor_id),
      namespace: String(row.neighbor_namespace),
      content: String(row.neighbor_content),
      normalized_content: String(row.neighbor_normalized_content ?? row.neighbor_content),
      content_hash: String(row.neighbor_content_hash ?? ""),
      summary: row.neighbor_summary === null ? null : String(row.neighbor_summary),
      kind: row.neighbor_kind,
      status: row.neighbor_status,
      importance: Number(row.neighbor_importance ?? 0.5),
      confidence: Number(row.neighbor_confidence ?? 1),
      tags: Array.isArray(row.neighbor_tags) ? row.neighbor_tags.map(String) : [],
      metadata: compactRecord(row.neighbor_metadata),
      source: compactRecord(row.neighbor_source),
      embedding_provider: row.neighbor_embedding_provider === null || row.neighbor_embedding_provider === undefined ? null : String(row.neighbor_embedding_provider),
      embedding_model: row.neighbor_embedding_model === null || row.neighbor_embedding_model === undefined ? null : String(row.neighbor_embedding_model),
      embedding_dimensions: row.neighbor_embedding_dimensions === null || row.neighbor_embedding_dimensions === undefined ? null : Number(row.neighbor_embedding_dimensions),
      version: Number(row.neighbor_version ?? 1),
      access_count: Number(row.neighbor_access_count ?? 0),
      last_accessed_at: row.neighbor_last_accessed_at ? new Date(row.neighbor_last_accessed_at) : null,
      expires_at: row.neighbor_expires_at ? new Date(row.neighbor_expires_at) : null,
      created_at: new Date(row.neighbor_created_at ?? Date.now()),
      updated_at: new Date(row.neighbor_updated_at ?? Date.now())
    };
  }

  private async rewireRelations(client: PoolClient, targetID: string, sourceIDs: string[]): Promise<void> {
    await client.query(
      `
      WITH rewired AS (
        SELECT
          CASE WHEN from_atom_id = ANY($2::uuid[]) THEN $1::uuid ELSE from_atom_id END AS new_from_atom_id,
          CASE WHEN to_atom_id = ANY($2::uuid[]) THEN $1::uuid ELSE to_atom_id END AS new_to_atom_id,
          relation_type,
          max(weight) AS weight,
          jsonb_build_object(
            'merged_relations',
            jsonb_agg(jsonb_build_object('id', id, 'metadata', metadata))
          ) AS metadata
        FROM atom_relations
        WHERE from_atom_id = ANY($2::uuid[]) OR to_atom_id = ANY($2::uuid[])
        GROUP BY 1,2,3
      )
      INSERT INTO atom_relations (from_atom_id, to_atom_id, relation_type, weight, metadata)
      SELECT new_from_atom_id, new_to_atom_id, relation_type, weight, metadata
      FROM rewired
      WHERE new_from_atom_id <> new_to_atom_id
      ON CONFLICT (from_atom_id, to_atom_id, relation_type) DO UPDATE SET
        weight = GREATEST(atom_relations.weight, EXCLUDED.weight),
        metadata = atom_relations.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      `,
      [targetID, sourceIDs]
    );
    await client.query(
      "DELETE FROM atom_relations WHERE from_atom_id = ANY($1::uuid[]) OR to_atom_id = ANY($1::uuid[])",
      [sourceIDs]
    );
  }
}
