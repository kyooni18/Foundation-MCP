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
import {
  clamp,
  compactRecord,
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
    score: Number(row.score ?? 0)
  };
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
    private readonly embeddings: EmbeddingService
  ) {}

  async create(input: AtomCreateInput): Promise<{ atom: AtomRow; created: boolean; deduplicated: boolean }> {
    const content = normalizeContent(input.content);
    if (!content) throw new Error("content must not be empty");
    if (content.length > 100_000) throw new Error("content exceeds 100000 characters");
    const namespace = normalizeNamespace(input.namespace ?? "default");
    const hash = sha256(content);
    const tags = normalizeTags(input.tags);
    const summary = normalizeOptionalText(input.summary, "summary", 2_000) ?? null;
    const expiresAt = parseOptionalDate(input.expiresAt, "expiresAt") ?? null;
    const embedding = await this.embeddings.embed(content);
    const dedupe = input.dedupe ?? "merge";

    if (dedupe === "error") {
      const result = await this.database.query(
        `
        INSERT INTO atoms (
          namespace, content, normalized_content, content_hash, summary, kind, importance, confidence,
          tags, metadata, source, expires_at, embedding, embedding_provider, embedding_model, embedding_dimensions
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::vector,$14,$15,$16
        ) RETURNING *
        `,
        [
          namespace, content, content, hash, summary, input.kind ?? "fact",
          clamp(input.importance ?? 0.5), clamp(input.confidence ?? 1), tags,
          JSON.stringify(input.metadata ?? {}), JSON.stringify(input.source ?? {}), expiresAt,
          this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null
        ]
      );
      const atom = atomFromRow(result.rows[0]!);
      await this.database.audit("create", atom.id, { namespace });
      return { atom, created: true, deduplicated: false };
    }

    const replace = dedupe === "replace";
    const result = await this.database.query(
      `
      INSERT INTO atoms (
        namespace, content, normalized_content, content_hash, summary, kind, importance, confidence,
        tags, metadata, source, expires_at, embedding, embedding_provider, embedding_model, embedding_dimensions
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::vector,$14,$15,$16
      )
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
        status = 'active',
        version = atoms.version + 1
      RETURNING *, (xmax = 0) AS was_inserted
      `,
      [
        namespace, content, content, hash, summary, input.kind ?? "fact",
        clamp(input.importance ?? 0.5), clamp(input.confidence ?? 1), tags,
        JSON.stringify(input.metadata ?? {}), JSON.stringify(input.source ?? {}), expiresAt,
        this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null,
        replace
      ]
    );
    const row = result.rows[0]!;
    const atom = atomFromRow(row);
    const created = Boolean(row.was_inserted);
    await this.database.audit(created ? "create" : "deduplicate", atom.id, { namespace, mode: dedupe });
    return { atom, created, deduplicated: !created };
  }

  async bulkCreate(items: AtomCreateInput[]): Promise<{ results: Array<Record<string, unknown>> }> {
    if (items.length < 1 || items.length > 100) throw new Error("items must contain between 1 and 100 atoms");
    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < items.length; index += 1) {
      try {
        const result = await this.create(items[index]!);
        results.push({ index, ok: true, ...result });
      } catch (error) {
        results.push({ index, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  }

  async get(id: string): Promise<AtomRow> {
    const result = await this.database.query("SELECT * FROM atoms WHERE id = $1", [id]);
    if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
    return atomFromRow(result.rows[0]);
  }

  async update(input: AtomUpdateInput): Promise<AtomRow> {
    const current = await this.get(input.id);
    const content = input.content === undefined ? current.content : normalizeContent(input.content);
    if (!content) throw new Error("content must not be empty");
    if (content.length > 100_000) throw new Error("content exceeds 100000 characters");
    const namespace = input.namespace === undefined ? current.namespace : normalizeNamespace(input.namespace);
    const summary = input.summary === undefined
      ? current.summary
      : normalizeOptionalText(input.summary, "summary", 2_000);
    const contentChanged = content !== current.normalized_content;
    const embedding = contentChanged ? await this.embeddings.embed(content) : null;
    const expiresAt = parseOptionalDate(input.expiresAt, "expiresAt");

    const result = await this.database.query(
      `
      UPDATE atoms SET
        namespace = $2,
        content = $3,
        normalized_content = $3,
        content_hash = $4,
        summary = $5,
        kind = $6,
        importance = $7,
        confidence = $8,
        tags = $9,
        metadata = $10::jsonb,
        source = $11::jsonb,
        expires_at = $12,
        embedding = CASE WHEN $13::boolean THEN $14::vector ELSE embedding END,
        embedding_provider = CASE WHEN $13::boolean THEN $15 ELSE embedding_provider END,
        embedding_model = CASE WHEN $13::boolean THEN $16 ELSE embedding_model END,
        embedding_dimensions = CASE WHEN $13::boolean THEN $17 ELSE embedding_dimensions END,
        version = version + 1
      WHERE id = $1 AND ($18::integer IS NULL OR version = $18)
      RETURNING *
      `,
      [
        input.id, namespace, content, sha256(content),
        summary,
        input.kind ?? current.kind,
        clamp(input.importance ?? current.importance),
        clamp(input.confidence ?? current.confidence),
        input.tags === undefined ? current.tags : normalizeTags(input.tags),
        JSON.stringify(input.metadata ?? current.metadata),
        JSON.stringify(input.source ?? current.source),
        expiresAt === undefined ? current.expires_at : expiresAt,
        contentChanged,
        this.vectorOrNull(embedding), embedding?.provider ?? null, embedding?.model ?? null, embedding?.dimensions ?? null,
        input.expectedVersion ?? null
      ]
    );
    if (!result.rows[0]) {
      const exists = await this.database.query("SELECT version FROM atoms WHERE id = $1", [input.id]);
      if (!exists.rows[0]) throw new Error(`Atom not found: ${input.id}`);
      throw new Error(`Version conflict: expected ${String(input.expectedVersion)}, current ${String(exists.rows[0].version)}`);
    }
    const atom = atomFromRow(result.rows[0]);
    await this.database.audit("update", atom.id, { fields: Object.keys(input).filter(key => key !== "id") });
    return atom;
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
    const candidateLimit = Math.min(2_000, Math.max(200, limit * 20));
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

    const result = await this.database.query(
      `
      WITH filtered AS NOT MATERIALIZED (
        SELECT a.*
        FROM atoms a
        WHERE ${conditions.join(" AND ")}
      ), semantic_candidates AS (
        SELECT id
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
        SELECT id
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
        SELECT id FROM semantic_candidates
        UNION
        SELECT id FROM lexical_candidates
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
          EXP(-GREATEST(EXTRACT(EPOCH FROM (NOW() - a.updated_at)) / 86400.0, 0) / ${halfLifeRef}) AS recency_score
        FROM filtered a
        JOIN candidate_ids c ON c.id = a.id
      ), scored AS (
        SELECT ranked.*,
          (
            ${semanticWeightRef} * semantic_score +
            ${lexicalWeightRef} * lexical_score +
            0.08 * importance +
            0.04 * confidence +
            0.03 * recency_score
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
    if (mode === "hard") {
      if (confirmation !== id) throw new Error("Hard deletion requires confirmation equal to the atom id");
      const result = await this.database.query("DELETE FROM atoms WHERE id = $1 RETURNING id", [id]);
      if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
      await this.database.audit("hard-delete", null, { id });
      return { id, status: "hard-deleted" };
    }
    const status = mode === "archive" ? "archived" : "deleted";
    const result = await this.database.query(
      "UPDATE atoms SET status = $2, version = version + 1 WHERE id = $1 RETURNING *",
      [id, status]
    );
    if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
    await this.database.audit(mode, id);
    return { atom: atomFromRow(result.rows[0]) };
  }

  async restore(id: string): Promise<AtomRow> {
    const result = await this.database.query(
      "UPDATE atoms SET status = 'active', version = version + 1 WHERE id = $1 RETURNING *",
      [id]
    );
    if (!result.rows[0]) throw new Error(`Atom not found: ${id}`);
    await this.database.audit("restore", id);
    return atomFromRow(result.rows[0]);
  }

  async link(input: {
    fromAtomID: string;
    toAtomID: string;
    relationType: string;
    weight?: number;
    metadata?: Record<string, unknown>;
  }): Promise<RelationRow> {
    if (input.fromAtomID === input.toAtomID) throw new Error("An atom cannot link to itself");
    const relationType = normalizeContent(input.relationType).toLocaleLowerCase("und").replace(/\s+/g, "_");
    if (!relationType) throw new Error("relationType must not be empty");
    if (relationType.length > 100) throw new Error("relationType exceeds 100 characters");
    const result = await this.database.query(
      `
      INSERT INTO atom_relations (from_atom_id, to_atom_id, relation_type, weight, metadata)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (from_atom_id, to_atom_id, relation_type) DO UPDATE SET
        weight = EXCLUDED.weight,
        metadata = atom_relations.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
      `,
      [input.fromAtomID, input.toAtomID, relationType, clamp(input.weight ?? 1), JSON.stringify(input.metadata ?? {})]
    );
    await this.database.audit("link", input.fromAtomID, { to: input.toAtomID, relationType });
    return relationFromRow(result.rows[0]!);
  }

  async unlink(input: { fromAtomID: string; toAtomID: string; relationType: string }): Promise<Record<string, unknown>> {
    const relationType = normalizeContent(input.relationType).toLocaleLowerCase("und").replace(/\s+/g, "_");
    if (!relationType) throw new Error("relationType must not be empty");
    if (relationType.length > 100) throw new Error("relationType exceeds 100 characters");
    const result = await this.database.query(
      `DELETE FROM atom_relations
       WHERE from_atom_id = $1 AND to_atom_id = $2 AND relation_type = $3
       RETURNING id`,
      [input.fromAtomID, input.toAtomID, relationType]
    );
    if (!result.rows[0]) throw new Error("Relation not found");
    await this.database.audit("unlink", input.fromAtomID, { to: input.toAtomID, relationType });
    return { removed: true, relationID: String(result.rows[0].id) };
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
      params.push(relationTypes.map(value => normalizeContent(value).toLocaleLowerCase("und").replace(/\s+/g, "_")));
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
        a.summary AS neighbor_summary,
        a.kind AS neighbor_kind,
        a.status AS neighbor_status,
        a.tags AS neighbor_tags
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
      neighbor: {
        id: row.neighbor_id,
        namespace: row.neighbor_namespace,
        content: row.neighbor_content,
        summary: row.neighbor_summary,
        kind: row.neighbor_kind,
        status: row.neighbor_status,
        tags: row.neighbor_tags
      }
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
      const metadata = Object.assign({}, ...sourceAtoms.map(atom => atom.metadata), target.metadata);
      const source = {
        ...target.source,
        merged_from: sourceAtoms.map(atom => ({ id: atom.id, source: atom.source }))
      };
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
      return atomFromRow(updated.rows[0]!);
    });
    await this.database.audit("merge", merged.id, { sourceIDs });
    return { atom: merged, mergedAtomIDs: sourceIDs };
  }

  async context(input: AtomSearchInput & { maxCharacters?: number; includeMetadata?: boolean }): Promise<Record<string, unknown>> {
    const search = await this.search(input);
    const maxCharacters = Math.max(256, Math.min(input.maxCharacters ?? 8_000, 50_000));
    let used = 0;
    const selected: SearchResult[] = [];
    const lines: string[] = [];
    for (const atom of search.results) {
      const line = `- [${atom.kind}] ${atom.content}${atom.summary ? ` — ${atom.summary}` : ""} (id: ${atom.id}, score: ${atom.score.toFixed(3)})`;
      if (used + line.length + 1 > maxCharacters) break;
      lines.push(line);
      selected.push(atom);
      used += line.length + 1;
    }
    return {
      query: search.query,
      effectiveMode: search.effectiveMode,
      context: lines.join("\n"),
      atomCount: selected.length,
      characters: used,
      atoms: input.includeMetadata ? selected : selected.map(({ metadata: _metadata, source: _source, ...atom }) => atom)
    };
  }

  async reembed(options: { namespace?: string; limit?: number; onlyMissing?: boolean }): Promise<Record<string, unknown>> {
    if (!this.embeddings.enabled) throw new Error("Embedding provider is disabled");
    const params: unknown[] = [];
    const conditions = ["status = 'active'"];
    if (options.namespace) { params.push(normalizeNamespace(options.namespace)); conditions.push(`namespace = $${params.length}`); }
    if (options.onlyMissing ?? true) conditions.push("embedding IS NULL");
    params.push(Math.max(1, Math.min(options.limit ?? 100, 1000)));
    const rows = await this.database.query(`SELECT id, content FROM atoms WHERE ${conditions.join(" AND ")} ORDER BY updated_at ASC LIMIT $${params.length}`, params);
    let updated = 0;
    const failures: Array<Record<string, unknown>> = [];
    for (const row of rows.rows) {
      try {
        const embedding = await this.embeddings.embed(String(row.content));
        if (!embedding) break;
        await this.database.query(
          "UPDATE atoms SET embedding=$2::vector, embedding_provider=$3, embedding_model=$4, embedding_dimensions=$5 WHERE id=$1",
          [row.id, vectorLiteral(embedding.vector), embedding.provider, embedding.model, embedding.dimensions]
        );
        updated += 1;
      } catch (error) {
        failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.database.audit("reembed", null, { updated, failures: failures.length });
    return { scanned: rows.rows.length, updated, failures };
  }

  async history(id: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query(
      `
      SELECT id, operation, atom_id, details, created_at
      FROM atom_events
      WHERE atom_id = $1 OR details->>'id' = $1
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
        count(*) FILTER (WHERE status='archived')::int AS archived,
        count(*) FILTER (WHERE status='deleted')::int AS deleted,
        count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
        count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= NOW())::int AS expired,
        COALESCE(avg(importance), 0)::double precision AS average_importance,
        COALESCE(avg(confidence), 0)::double precision AS average_confidence,
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
    return { namespace: normalizedNamespace, ...result.rows[0], kinds: kinds.rows };
  }

  private vectorOrNull(embedding: EmbeddingResult | null): string | null {
    return embedding ? vectorLiteral(embedding.vector) : null;
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
