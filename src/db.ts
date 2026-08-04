import pg from "pg";
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Config } from "./config.js";

const { Pool } = pg;

export class Database {
  readonly pool: PgPool;

  constructor(readonly config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseURL,
      max: config.databasePoolSize,
      application_name: "foundation-mcp"
    });
    this.pool.on("error", (error: Error) => console.error("PostgreSQL pool error", error));
  }

  async initialize(): Promise<void> {
    await this.pool.query("SELECT 1");
    if (this.config.autoMigrate) await this.migrate();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(operation: string, atomID: string | null, details: Record<string, unknown> = {}): Promise<void> {
    if (!this.config.enableAudit) return;
    await this.pool.query(
      "INSERT INTO atom_events (operation, atom_id, details) VALUES ($1, $2, $3::jsonb)",
      [operation, atomID, JSON.stringify(details)]
    );
  }

  async health(): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{
      database: string;
      server_time: Date;
      atom_count: string;
    }>(
      `
      SELECT
        current_database() AS database,
        now() AS server_time,
        (SELECT count(*)::text FROM atoms WHERE status = 'active') AS atom_count
      `
    );
    return result.rows[0] ?? {};
  }

  private async migrate(): Promise<void> {
    const dimensions = this.config.embeddingDimensions;
    const vectorIndex = `atoms_embedding_hnsw_${dimensions}`;
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('foundation-mcp-schema-v1'))");
      await client.query("BEGIN");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
      await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

      await client.query(
        `
        CREATE TABLE IF NOT EXISTS atoms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          namespace TEXT NOT NULL DEFAULT 'default',
          content TEXT NOT NULL,
          normalized_content TEXT NOT NULL,
          content_hash CHAR(64) NOT NULL,
          summary TEXT,
          kind TEXT NOT NULL DEFAULT 'fact',
          status TEXT NOT NULL DEFAULT 'active',
          importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
          tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          source JSONB NOT NULL DEFAULT '{}'::JSONB,
          embedding VECTOR,
          embedding_provider TEXT,
          embedding_model TEXT,
          embedding_dimensions INTEGER,
          search_document TSVECTOR NOT NULL DEFAULT ''::TSVECTOR,
          version INTEGER NOT NULL DEFAULT 1,
          access_count BIGINT NOT NULL DEFAULT 0,
          last_accessed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT atoms_kind_check CHECK (kind IN ('fact','preference','person','event','task','note','procedure','concept','observation')),
          CONSTRAINT atoms_status_check CHECK (status IN ('active','archived','deleted')),
          CONSTRAINT atoms_importance_check CHECK (importance >= 0 AND importance <= 1),
          CONSTRAINT atoms_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
          CONSTRAINT atoms_embedding_shape_check CHECK (
            (embedding IS NULL AND embedding_provider IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL)
            OR
            (embedding IS NOT NULL AND embedding_provider IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimensions = vector_dims(embedding))
          ),
          UNIQUE (namespace, content_hash)
        )
        `
      );

      await client.query(
        `
        CREATE OR REPLACE FUNCTION foundation_atoms_search_document() RETURNS trigger AS $$
        BEGIN
          NEW.updated_at = NOW();
          NEW.search_document = to_tsvector(
            'simple',
            concat_ws(' ', NEW.content, COALESCE(NEW.summary, ''), array_to_string(NEW.tags, ' '))
          );
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        `
      );
      await client.query("DROP TRIGGER IF EXISTS atoms_search_document_trigger ON atoms");
      await client.query(
        `
        CREATE TRIGGER atoms_search_document_trigger
        BEFORE INSERT OR UPDATE ON atoms
        FOR EACH ROW EXECUTE FUNCTION foundation_atoms_search_document()
        `
      );

      await client.query("CREATE INDEX IF NOT EXISTS atoms_namespace_status_idx ON atoms (namespace, status, updated_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_kind_idx ON atoms (kind)");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_expires_idx ON atoms (expires_at) WHERE expires_at IS NOT NULL");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_tags_gin ON atoms USING GIN (tags)");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_metadata_gin ON atoms USING GIN (metadata)");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_search_gin ON atoms USING GIN (search_document)");
      await client.query("CREATE INDEX IF NOT EXISTS atoms_content_trgm ON atoms USING GIN (content gin_trgm_ops)");
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${vectorIndex} ON atoms USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops) WHERE embedding IS NOT NULL AND embedding_dimensions = ${dimensions} `
      );

      await client.query(
        `
        CREATE TABLE IF NOT EXISTS atom_relations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          from_atom_id UUID NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
          to_atom_id UUID NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT atom_relations_no_self CHECK (from_atom_id <> to_atom_id),
          CONSTRAINT atom_relations_weight_check CHECK (weight >= 0 AND weight <= 1),
          UNIQUE (from_atom_id, to_atom_id, relation_type)
        )
        `
      );
      await client.query("CREATE INDEX IF NOT EXISTS atom_relations_from_idx ON atom_relations (from_atom_id)");
      await client.query("CREATE INDEX IF NOT EXISTS atom_relations_to_idx ON atom_relations (to_atom_id)");

      await client.query(
        `
        CREATE TABLE IF NOT EXISTS atom_events (
          id BIGSERIAL PRIMARY KEY,
          operation TEXT NOT NULL,
          atom_id UUID REFERENCES atoms(id) ON DELETE SET NULL,
          details JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `
      );
      await client.query("CREATE INDEX IF NOT EXISTS atom_events_atom_idx ON atom_events (atom_id, created_at DESC)");
      await client.query("CREATE INDEX IF NOT EXISTS atom_events_time_idx ON atom_events (created_at DESC)");

      await client.query(
        `
        CREATE TABLE IF NOT EXISTS foundation_schema (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        `
      );
      await client.query("INSERT INTO foundation_schema (version) VALUES (1) ON CONFLICT DO NOTHING");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('foundation-mcp-schema-v1'))").catch(() => undefined);
      client.release();
    }
  }
}
