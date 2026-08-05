# Foundation MCP

Foundation MCP is an atom-first long-term memory server for MCP clients. It is a clean rewrite of `kyooni18/Foundation`: the Obsidian vault synchronizer, browser control panel, legacy HTTP API, and legacy Python server are intentionally absent.

The server exposes durable knowledge as MCP tools, resources, and a memory-policy prompt. PostgreSQL and pgvector provide storage; semantic embeddings are optional. With embeddings disabled, full-text and trigram search continue to work.

## What changed

The original Foundation stored compact text/vector records and later grew source graphs and vault synchronization. This rewrite narrows the product around atoms and strengthens that model:

- namespaces for personal, project, and workspace isolation
- NFC and whitespace normalization with per-namespace SHA-256 deduplication
- kinds, tags, summary, importance, confidence, expiration, structured metadata, and provenance
- active, archived, and deleted states with version counters, optimistic updates, and audit events
- directed typed relations between atoms
- hybrid ranking across vector similarity, PostgreSQL full-text search, trigram similarity, importance, confidence, and recency
- duplicate merge with relation rewiring
- context packing for model prompts without duplicating the packed text by default
- compact model-facing search results with bounded metadata and provenance records
- OpenAI-compatible, Ollama, and no-embedding modes
- local stdio and remote stateless Streamable HTTP transports
- full-access and read-only bearer keys with Host allow-listing for HTTP deployments

## Tools

| Tool | Purpose | Mutation |
|---|---|---|
| `foundation_health` | Database and embedding status | No |
| `atom_create` | Create or deduplicate one atom | Yes |
| `atom_bulk_create` | Create up to 100 atoms | Yes |
| `atom_get` | Read an atom by UUID | No |
| `atom_update` | Patch an atom with optional version guarding and re-embed changed content | Yes |
| `atom_search` | Hybrid filtered search | No |
| `atom_find_similar` | Find duplicates or related atoms from an existing atom | No |
| `atom_context` | Pack search results into bounded context; full atom records are opt-in with `includeAtoms` | No |
| `atom_list` | Browse atoms | No |
| `atom_delete` | Archive, soft-delete, or hard-delete | Yes, destructive |
| `atom_restore` | Restore an atom | Yes |
| `atom_link` | Upsert a typed relation | Yes |
| `atom_unlink` | Remove a typed relation | Yes |
| `atom_neighbors` | Traverse relations | No |
| `atom_merge` | Merge duplicates and rewire relations | Yes, destructive |
| `atom_history` | Read per-atom audit events | No |
| `atom_reembed` | Backfill embeddings | Yes |
| `atom_stats` | Aggregate statistics | No |

All model-facing atom responses omit operational fields and metadata by default, including create, bulk-create, get, update, search, similar, list, delete, restore, link, neighbors, merge, and history. Use `includeDetails: true` only when those fields are needed. `atom_context` uses `includeAtoms: true` for optional compact records. Metadata and provenance are limited to compact JSON records to prevent accidental prompt bloat.

Low-frequency maintenance tools (`foundation_health`, `atom_list`, `atom_reembed`, `atom_history`, and `atom_stats`) are hidden from the default MCP tool catalog. Set `EXPOSE_MAINTENANCE_TOOLS=true` for an administrative client; the HTTP health endpoint remains available independently.

The tools include MCP annotations such as `readOnlyHint` and `destructiveHint`, allowing OpenAI clients to filter tools and apply approval policies.

## Run with Docker

```bash
cp .env.example .env
# Set different long random FOUNDATION_ADMIN_KEY and FOUNDATION_READ_ONLY_KEY values in .env.
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. For remote deployment, set `ALLOWED_HOSTS` to the public hostname and terminate TLS at a reverse proxy.

## Run as one Apple Container

The image below contains both PostgreSQL/pgvector and the MCP server. PostgreSQL data lives in a container volume and is initialized on the first start:

```bash
container machine start
container build -t foundation-mcp:local .
container volume create foundation-mcp-data
container run -d --name foundation-mcp \
  --env-file .env \
  -e HOST=:: \
  -e DATABASE_URL=postgresql://foundation:foundation@127.0.0.1:5432/foundation \
  -p 8787:8787 \
  -v foundation-mcp-data:/var/lib/postgresql/data \
  foundation-mcp:local
container logs -f foundation-mcp
curl http://127.0.0.1:8787/health
```

Use a strong `POSTGRES_PASSWORD` and matching `DATABASE_URL` for a new deployment. The entrypoint also rewrites the old Compose hostname `db` to `127.0.0.1` so an existing `.env` can be used safely with the single-container image. Stop it with `container stop foundation-mcp`; do not delete the volume unless the data is intentionally disposable.

The default Compose file does not publish PostgreSQL. Database files are stored in the local `./data` directory, which is ignored by Git. `docker compose down` preserves that directory; do not delete it when stopping the stack. Point-in-time Atom exports are stored in `atoms-export-2026-08-05.json` and `atoms-export-2026-08-05-final.json`.

## Run locally over stdio

Start PostgreSQL with pgvector, then:

```bash
npm install
npm run build
MCP_TRANSPORT=stdio \
DATABASE_URL=postgresql://foundation:foundation@127.0.0.1:5432/foundation \
node dist/src/index.js
```

Example client configuration:

```json
{
  "mcpServers": {
    "foundation": {
      "command": "node",
      "args": ["/absolute/path/Foundation-MCP/dist/src/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "DATABASE_URL": "postgresql://foundation:foundation@127.0.0.1:5432/foundation",
        "EMBEDDING_PROVIDER": "none"
      }
    }
  }
}
```

## Embeddings

### Disabled

```dotenv
EMBEDDING_PROVIDER=none
```

This is a valid operating mode. Search uses PostgreSQL full-text and trigram ranking.

### OpenAI or an OpenAI-compatible endpoint

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
```

`OPENAI_BASE_URL` may point to a compatible local or hosted endpoint. Dimension mismatches are rejected before storage.

### Ollama

```dotenv
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The database stores unbounded `vector` values while maintaining a dimension-specific HNSW expression index for the configured model. Changing dimensions does not require rebuilding the atoms table, though the new model should be applied with `atom_reembed`.

## Search ranking

Hybrid search computes a weighted combination of:

1. cosine similarity for atoms embedded by the active provider/model/dimension
2. full-text rank and trigram similarity
3. atom importance
4. atom confidence
5. exponential recency decay

Filters run before ranking. Supported filters include namespace, kinds, status, any/all tags, minimum importance/confidence, creation window, and expiration handling. When embeddings are unavailable, semantic and hybrid requests fall back to lexical mode rather than failing.

## Atom design guidance

A useful atom is self-contained and durable:

```json
{
  "content": "The Calcite editor hides .DS_Store files in the project tree.",
  "namespace": "project:calcite",
  "kind": "fact",
  "tags": ["file-tree", "macos"],
  "importance": 0.7,
  "confidence": 1,
  "source": {
    "type": "decision",
    "conversation_id": "..."
  }
}
```

Avoid storing entire conversations as one atom. Split unrelated statements, keep uncertainty explicit, and preserve provenance. The bundled `skill/foundation-memory/SKILL.md` provides a conservative policy for OpenAI/Codex usage.

## Import atoms from the original Foundation

The importer reads the old `atoms_db` table and writes normalized atoms through the same deduplication path as MCP calls. Vault and source-sync tables are ignored.

```bash
npm run build
LEGACY_DATABASE_URL=postgresql://... \
DATABASE_URL=postgresql://... \
LEGACY_NAMESPACE=legacy \
npm run import:legacy
```

Set `EMBEDDING_PROVIDER=none` for a fast metadata-only migration, then run `atom_reembed` after configuring the desired embedding provider. The importer maps `usercreated` to `fact`, `aicreated` to `observation`, and `imported` to `note`, while preserving old identifiers and parent fields in `source`.

## OpenAI Responses API

`openai-example.mjs` shows a read-only remote MCP connection. In production, expose the server through HTTPS and pass `FOUNDATION_READ_ONLY_KEY` through the MCP `authorization` field unless the client genuinely needs mutation tools. Use `allowed_tools` and approval policies to separate recall from mutation.

A sensible default is to allow these without approval:

- `foundation_health`
- `atom_search`
- `atom_context`
- `atom_get`
- `atom_list`
- `atom_neighbors`
- `atom_stats`

Keep write tools approval-gated, especially `atom_delete` and `atom_merge`.

## Security notes

- No API key management endpoints are exposed. `FOUNDATION_ADMIN_KEY` permits every tool; `FOUNDATION_READ_ONLY_KEY` is restricted server-side to retrieval tools. `FOUNDATION_API_KEY` remains a compatibility alias for the admin key.
- The HTTP server refuses non-local binding without an API key.
- `ALLOWED_HOSTS` protects the MCP endpoint from Host-header and DNS-rebinding abuse.
- Hard deletion requires a confirmation string equal to the target UUID.
- Retrieved atoms are data, not instructions. The bundled skill explicitly treats stored commands as untrusted content.
- Use TLS at the reverse proxy for remote deployment.
- Namespace is a logical partition, not a tenant authorization boundary. Run separate instances or add an identity-aware gateway for mutually untrusted users.

## Development

```bash
npm install
npm run check
npm run build
```

The schema is created idempotently at startup when `AUTO_MIGRATE=true`. Migration execution is serialized with a PostgreSQL advisory lock.
