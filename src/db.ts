import pg from "pg";
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { Config } from "./config.js";
import { LATEST_SCHEMA_VERSION, migrations } from "./migrations.js";
import { logger, metrics } from "./telemetry.js";

const { Pool } = pg;

type Queryable = Pick<PoolClient, "query">;

export class Database {
  readonly pool: PgPool;

  constructor(readonly config: Config) {
    this.pool = new Pool({
      connectionString: config.databaseURL,
      max: config.databasePoolSize,
      application_name: "foundation-mcp"
    });
    this.pool.on("error", (error: Error) => logger.error("PostgreSQL pool error", { error: error.message }));
  }

  async initialize(): Promise<void> {
    await this.query("SELECT 1");
    if (this.config.autoMigrate) {
      await this.migrate();
    } else {
      const version = await this.schemaVersion();
      if (version < LATEST_SCHEMA_VERSION) {
        throw new Error(`Database schema ${version} is older than required schema ${LATEST_SCHEMA_VERSION}. Enable AUTO_MIGRATE=true or run a migration before starting Foundation.`);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const started = process.hrtime.bigint();
    try {
      const result = await this.pool.query<T>(text, values);
      metrics.increment("db_queries_total");
      return result;
    } catch (error) {
      metrics.increment("db_query_errors_total");
      throw error;
    } finally {
      metrics.observe("db_query", Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const started = process.hrtime.bigint();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      metrics.increment("db_transactions_total");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      metrics.increment("db_transaction_errors_total");
      throw error;
    } finally {
      metrics.observe("db_transaction", Number(process.hrtime.bigint() - started) / 1e9);
      client.release();
    }
  }

  async audit(operation: string, atomID: string | null, details: Record<string, unknown> = {}): Promise<void> {
    return this.auditWith(this.pool, operation, atomID, details);
  }

  async auditWith(client: Queryable, operation: string, atomID: string | null, details: Record<string, unknown> = {}): Promise<void> {
    if (!this.config.enableAudit) return;
    await client.query(
      "INSERT INTO atom_events (operation, atom_id, details) VALUES ($1, $2, $3::jsonb)",
      [operation, atomID, JSON.stringify(details)]
    );
  }

  async schemaVersion(): Promise<number> {
    try {
      const result = await this.query<{ version: number }>("SELECT COALESCE(max(version), 0)::int AS version FROM foundation_schema");
      return Number(result.rows[0]?.version ?? 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/foundation_schema|does not exist/i.test(message)) return 0;
      throw error;
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const result = await this.query<{
      database: string;
      server_time: Date;
      atom_count: string;
      embedded_count: string;
      pool_connections: string;
    }>(
      `
      SELECT
        current_database() AS database,
        now() AS server_time,
        (SELECT count(*)::text FROM atoms WHERE status = 'active') AS atom_count,
        (SELECT count(*)::text FROM atoms WHERE status = 'active' AND embedding IS NOT NULL) AS embedded_count,
        (SELECT count(*)::text FROM pg_stat_activity WHERE datname = current_database()) AS pool_connections
      `
    );
    return {
      ...(result.rows[0] ?? {}),
      schema_version: await this.schemaVersion(),
      latest_schema_version: LATEST_SCHEMA_VERSION,
      pool: {
        total: this.pool.totalCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
        configured_max: this.config.databasePoolSize
      }
    };
  }

  async indexHealth(): Promise<Array<Record<string, unknown>>> {
    const result = await this.query(
      `SELECT indexrelname AS index_name, idx_scan::bigint, idx_tup_read::bigint, idx_tup_fetch::bigint
       FROM pg_stat_user_indexes
       WHERE relname IN ('atoms','atom_relations','atom_feedback')
       ORDER BY relname, indexrelname`
    );
    return result.rows;
  }

  async cleanupOAuth(): Promise<{ codes: number; tokens: number }> {
    return this.transaction(async client => {
      const codes = await client.query("DELETE FROM oauth_authorization_codes WHERE expires_at < NOW() - INTERVAL '1 hour' OR used_at < NOW() - INTERVAL '1 day'");
      const tokens = await client.query("DELETE FROM oauth_tokens WHERE expires_at < NOW() - INTERVAL '1 day' OR revoked_at < NOW() - INTERVAL '1 day'");
      return { codes: codes.rowCount ?? 0, tokens: tokens.rowCount ?? 0 };
    });
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('foundation-mcp-schema-v1'))");
      await client.query(
        `CREATE TABLE IF NOT EXISTS foundation_schema (
          version INTEGER PRIMARY KEY,
          name TEXT,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );
      await client.query("ALTER TABLE foundation_schema ADD COLUMN IF NOT EXISTS name TEXT");

      // Foundation MCP releases before numbered migrations may already have the
      // core tables. Infer that baseline instead of trying to recreate it. This
      // is intentionally conservative: the old pre-MCP Foundation uses
      // `atoms_db` and is migrated by legacy-import.ts instead.
      const baseline = await client.query<{ atoms: string | null; oauth_clients: string | null; oauth_codes: string | null; oauth_tokens: string | null; core_columns: number }>(
        `SELECT
           to_regclass('public.atoms')::text AS atoms,
           to_regclass('public.oauth_clients')::text AS oauth_clients,
           to_regclass('public.oauth_authorization_codes')::text AS oauth_codes,
           to_regclass('public.oauth_tokens')::text AS oauth_tokens,
           (SELECT count(*)::int FROM information_schema.columns
             WHERE table_schema='public' AND table_name='atoms'
               AND column_name = ANY(ARRAY['namespace','content','normalized_content','content_hash','search_document','version','access_count'])) AS core_columns`
      );
      const existingVersions = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM foundation_schema");
      if (Number(existingVersions.rows[0]?.count ?? 0) === 0 && baseline.rows[0]?.atoms && Number(baseline.rows[0]?.core_columns ?? 0) === 7) {
        await client.query("INSERT INTO foundation_schema(version,name) VALUES (1,'legacy-core-baseline') ON CONFLICT DO NOTHING");
        if (baseline.rows[0]?.oauth_clients && baseline.rows[0]?.oauth_codes && baseline.rows[0]?.oauth_tokens) {
          await client.query("INSERT INTO foundation_schema(version,name) VALUES (2,'legacy-oauth-baseline') ON CONFLICT DO NOTHING");
        }
      }

      const appliedResult = await client.query<{ version: number }>("SELECT version FROM foundation_schema ORDER BY version");
      const applied = new Set(appliedResult.rows.map(row => Number(row.version)));

      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        logger.info("Applying database migration", { version: migration.version, name: migration.name });
        await client.query("BEGIN");
        try {
          for (const statement of migration.statements(this.config.embeddingDimensions)) {
            await client.query(statement);
          }
          await client.query(
            "INSERT INTO foundation_schema (version, name) VALUES ($1, $2) ON CONFLICT (version) DO UPDATE SET name=EXCLUDED.name",
            [migration.version, migration.name]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      // Embedding dimensions are runtime-configurable. Ensure an index for the active
      // dimension even when all numbered migrations were applied previously.
      const dimensions = this.config.embeddingDimensions;
      await client.query(
        `CREATE INDEX IF NOT EXISTS atoms_embedding_hnsw_${dimensions} ON atoms USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops) WHERE embedding IS NOT NULL AND embedding_dimensions = ${dimensions}`
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('foundation-mcp-schema-v1'))").catch(() => undefined);
      client.release();
    }
  }
}
