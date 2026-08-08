export interface Migration {
  version: number;
  name: string;
  statements: (dimensions: number) => string[];
}

export const LATEST_SCHEMA_VERSION = 6;

export const migrations: Migration[] = [
  {
    version: 1,
    name: "core-atom-schema",
    statements: dimensions => [
      `CREATE EXTENSION IF NOT EXISTS vector`,
      `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
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
      `,
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
      `,
      `DROP TRIGGER IF EXISTS atoms_search_document_trigger ON atoms`,
      `
      CREATE TRIGGER atoms_search_document_trigger
      BEFORE INSERT OR UPDATE ON atoms
      FOR EACH ROW EXECUTE FUNCTION foundation_atoms_search_document()
      `,
      `CREATE INDEX IF NOT EXISTS atoms_namespace_status_idx ON atoms (namespace, status, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS atoms_kind_idx ON atoms (kind)`,
      `CREATE INDEX IF NOT EXISTS atoms_expires_idx ON atoms (expires_at) WHERE expires_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS atoms_tags_gin ON atoms USING GIN (tags)`,
      `CREATE INDEX IF NOT EXISTS atoms_metadata_gin ON atoms USING GIN (metadata)`,
      `CREATE INDEX IF NOT EXISTS atoms_search_gin ON atoms USING GIN (search_document)`,
      `CREATE INDEX IF NOT EXISTS atoms_content_trgm ON atoms USING GIN (content gin_trgm_ops)`,
      `CREATE INDEX IF NOT EXISTS atoms_embedding_hnsw_${dimensions} ON atoms USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops) WHERE embedding IS NOT NULL AND embedding_dimensions = ${dimensions}`,
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
      `,
      `CREATE INDEX IF NOT EXISTS atom_relations_from_idx ON atom_relations (from_atom_id)`,
      `CREATE INDEX IF NOT EXISTS atom_relations_to_idx ON atom_relations (to_atom_id)`,
      `
      CREATE TABLE IF NOT EXISTS atom_events (
        id BIGSERIAL PRIMARY KEY,
        operation TEXT NOT NULL,
        atom_id UUID REFERENCES atoms(id) ON DELETE SET NULL,
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      `,
      `CREATE INDEX IF NOT EXISTS atom_events_atom_idx ON atom_events (atom_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS atom_events_time_idx ON atom_events (created_at DESC)`
    ]
  },
  {
    version: 2,
    name: "oauth",
    statements: () => [
      `
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris TEXT[] NOT NULL,
        grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token']::TEXT[],
        response_types TEXT[] NOT NULL DEFAULT ARRAY['code']::TEXT[],
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT oauth_clients_auth_method_check CHECK (token_endpoint_auth_method = 'none')
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash CHAR(64) PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT[] NOT NULL,
        resource TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
      `,
      `CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry_idx ON oauth_authorization_codes (expires_at)`,
      `
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token_hash CHAR(64) PRIMARY KEY,
        token_type TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        scopes TEXT[] NOT NULL,
        resource TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT oauth_tokens_type_check CHECK (token_type IN ('access','refresh'))
      )
      `,
      `CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx ON oauth_tokens (client_id, token_type)`,
      `CREATE INDEX IF NOT EXISTS oauth_tokens_expiry_idx ON oauth_tokens (expires_at)`
    ]
  },
  {
    version: 3,
    name: "feedback-jobs-and-namespace-grants",
    statements: () => [
      `ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS allowed_namespaces TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[]`,
      `ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS allowed_namespaces TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[]`,
      `ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS allowed_namespaces TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[]`,
      `
      CREATE TABLE IF NOT EXISTS atom_feedback (
        id BIGSERIAL PRIMARY KEY,
        atom_id UUID NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
        signal SMALLINT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'explicit',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT atom_feedback_signal_check CHECK (signal >= -1 AND signal <= 1)
      )
      `,
      `CREATE INDEX IF NOT EXISTS atom_feedback_atom_idx ON atom_feedback (atom_id, created_at DESC)`,
      `
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        details JSONB NOT NULL DEFAULT '{}'::JSONB,
        result JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        CONSTRAINT maintenance_jobs_status_check CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
      )
      `,
      `CREATE INDEX IF NOT EXISTS maintenance_jobs_status_idx ON maintenance_jobs (status, created_at DESC)`
    ]
  },
  {
    version: 4,
    name: "adaptive-retrieval-indexes",
    statements: () => [
      `CREATE INDEX IF NOT EXISTS atoms_access_idx ON atoms (access_count DESC, last_accessed_at DESC) WHERE status = 'active'`,
      `CREATE INDEX IF NOT EXISTS atoms_embedding_signature_idx ON atoms (embedding_provider, embedding_model, embedding_dimensions) WHERE embedding IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS atom_relations_type_idx ON atom_relations (relation_type, weight DESC)`
    ]
  },
  {
    version: 5,
    name: "maintenance-hardening",
    statements: () => [
      `UPDATE maintenance_jobs SET status='failed', error=COALESCE(error, 'Server restarted while job was running'), finished_at=NOW() WHERE status='running'`,
      `CREATE INDEX IF NOT EXISTS oauth_tokens_active_idx ON oauth_tokens (expires_at) WHERE revoked_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS oauth_codes_unused_idx ON oauth_authorization_codes (expires_at) WHERE used_at IS NULL`
    ]
  },
  {
    version: 6,
    name: "atom-lifecycle-states",
    statements: () => [
      `ALTER TABLE atoms DROP CONSTRAINT IF EXISTS atoms_status_check`,
      `ALTER TABLE atoms ADD CONSTRAINT atoms_status_check CHECK (status IN ('active','resolved','superseded','deprecated','archived','deleted'))`,
      `UPDATE atoms a SET status='superseded' FROM atom_relations r WHERE r.to_atom_id=a.id AND r.relation_type='supersedes' AND a.status='archived'`
    ]
  }
];
