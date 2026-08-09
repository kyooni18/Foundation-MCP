# Foundation MCP

Foundation MCP is an atom-first long-term memory server for MCP clients. Version 0.3 keeps the existing MCP, HTTP, API-key, OAuth, stdio, and atom-storage mechanisms while adding retrieval planning, adaptive memory signals, safer maintenance, additive schema migrations, namespace authorization, observability, and operator tooling.

The core `atoms` table remains the same. The v0.3 database changes are intentionally small: three namespace-grant columns are added to the existing OAuth tables, and two auxiliary tables store explicit retrieval feedback and maintenance-job state. Existing atom IDs, relations, events, embeddings, namespaces, and API behavior remain usable.

## Compatibility

`MCP_TOOL_PROFILE` controls the MCP tool surface. The default is `balanced`, which exposes only six compact high-level `memory_*` tools. Set `MCP_TOOL_PROFILE=full` to restore the existing low-level `atom_*` and operator tool surface. Existing `.env` files need no changes because the default is built in.

In `full`, existing low-level tools keep their existing names and arguments:

- `atom_bulk_create` accepts an optional `atomic` flag; the default remains independent per-item success/failure.
- `atom_context` accepts an optional `maxTokens` budget in addition to the existing character budget.
- Existing relation-name normalization is unchanged; standard relation types are additive conventions and custom relation types remain supported exactly as before.
- `FOUNDATION_API_KEY` remains a compatibility alias for `FOUNDATION_ADMIN_KEY`.
- `/health` remains available and now aliases the readiness check.
- OAuth authorization code + PKCE, dynamic client registration, refresh tokens, and revocation remain intact.

Low-frequency administrative tools remain hidden unless both `MCP_TOOL_PROFILE=full` and `EXPOSE_MAINTENANCE_TOOLS=true`. The `balanced` profile never exposes `atom_*`, health, diagnostics, or maintenance tools.

## What v0.3 improves

### Retrieval and context quality

Hybrid search now uses a two-stage candidate/reranking pipeline. Semantic and lexical candidate sets are combined with reciprocal-rank evidence, then reranked using semantic relevance, lexical relevance, importance, confidence, recency, a bounded access signal, and explicit usefulness feedback.

`atom_context` over-fetches candidates, optionally decomposes long multi-part queries, removes redundant results using MMR-style diversity selection, optionally expands strong same-namespace relations, and packs the final context against character and approximate token budgets. Selected memories update the existing `access_count` and `last_accessed_at` fields. Explicit positive/neutral/negative retrieval feedback is kept separately so simple exposure is not confused with usefulness.

The adaptive weights are intentionally small. Frequently returned memories therefore receive only a modest boost instead of becoming permanently dominant.

### Embedding efficiency

Exact duplicates are checked before a single-item embedding request. Bulk embedding requests deduplicate identical texts, batch provider requests, use bounded concurrency, cache query/content embeddings in memory, retry transient failures with backoff, and preserve the legacy partial-success behavior by falling back to per-item embedding when a batch fails.

Re-embedding can detect atoms whose provider, model, or dimensions no longer match the configured embedding model, making model migrations resumable in bounded batches.

### Smart-memory model cost control

The smart-memory path is now deterministic-first. Existing `.env` files remain valid and do not require any new variables. Existing `SMART_MODEL_ENABLED`, `SMART_MODEL`, `SMART_MODEL_API_KEY`, and `SMART_MODEL_BASE_URL` settings are still recognized. New cost-control settings are optional overrides only.

`memory_recall` never invokes the smart model. `memory_remember` first performs normalization, deterministic list/sentence splitting, heuristic kind/importance classification, and a lexical-only duplicate/change candidate lookup. Exact/strong duplicates and ordinary single-atom writes therefore complete without a generative-model request. The smart model is reserved for genuinely ambiguous existing-memory matches or long prose that cannot be split safely by simple structure. One `memory_remember` operation can make at most one smart-model request.

Repeated ambiguous decisions are cached in memory using the normalized text plus candidate atom IDs and versions. A candidate version change naturally invalidates the cache. Smart requests use compact candidate records, capped input text, low reasoning effort, structured JSON output, `store: false`, and a bounded output budget. If the model is unavailable, disabled, times out, exceeds a budget, or returns invalid output, Foundation falls back to deterministic storage instead of failing the memory write.

Without adding anything to `.env`, the built-in limits are:

- maximum smart-model calls per UTC day: **32**
- estimated smart-model input budget per UTC day: **24,000 tokens**
- maximum text sent from one memory request: **3,200 characters**
- maximum model output: **320 tokens**
- decision cache TTL: **7 days**
- smart-model timeout: **15 seconds**

Set either daily budget to `0` only when an unlimited budget is explicitly desired. The limits reset in process at the UTC day boundary; restarting the server also resets the in-process counters. They are a usage guard, not a billing-provider hard limit.

`foundation://stats`, `foundation_health`, and `foundation_diagnostics` expose smart-model calls, cache hits, deterministic/read/budget avoided calls, failures, input/output token counts, and current daily budget consumption. These counters contain no memory contents.

Optional overrides, if tuning is needed later:

```dotenv
SMART_MODEL_MAX_INPUT_CHARACTERS=3200
SMART_MODEL_MAX_OUTPUT_TOKENS=320
SMART_MODEL_LONG_INPUT_THRESHOLD=900
SMART_MODEL_AMBIGUOUS_LEXICAL_THRESHOLD=0.62
SMART_MODEL_DUPLICATE_LEXICAL_THRESHOLD=0.93
SMART_MODEL_CACHE_SIZE=2000
SMART_MODEL_CACHE_TTL_SECONDS=604800
SMART_MODEL_TIMEOUT_MS=15000
SMART_MODEL_DAILY_CALL_BUDGET=32
SMART_MODEL_DAILY_INPUT_TOKEN_BUDGET=24000
```

### Memory maintenance

Foundation now defines common relation conventions such as `supports`, `contradicts`, `supersedes`, `derived_from`, `duplicate_of`, and `related_to` while continuing to preserve custom relation names with the same normalization behavior as earlier releases.

`atom_supersede` creates a replacement, links it to the older memory, and optionally archives the older atom in one transaction. `atom_consolidate` conservatively scans a bounded recent window for strong near-duplicates and creates `duplicate_of` suggestion relations; it does not automatically merge or delete data. `atom_lifecycle_suggestions` identifies possible review, promotion, or decay candidates from age, access, importance, and feedback without mutating them.

Maintenance jobs are persisted in `maintenance_jobs`. MCP-triggered maintenance returns a queued job ID immediately instead of blocking the request. Re-embedding, duplicate suggestion scans, OAuth cleanup, and optional expiration archival can also run on a low-frequency internal schedule.

### Consistency

Atom mutations and their audit events now share the same PostgreSQL transaction. This prevents successful writes from being separated from failed audit writes. Bulk creation additionally offers an opt-in all-or-nothing transaction while retaining the old independent-item default.

### Namespace authorization

Namespaces are still logical atom partitions, but they can now also be constrained per credential. Admin keys, read-only keys, and OAuth clients can each receive exact namespace grants or trailing-prefix grants such as `project:*`.

The default grant is `*`, so existing deployments keep their current behavior unless an administrator opts into restrictions. Authorization checks include both source and destination namespaces for moves and all involved atoms for relations and merges. Global maintenance requires an all-namespace credential.

OAuth client namespace grants can be changed with:

```bash
npm run build
node dist/src/admin.js oauth-namespaces <client-id> 'personal,project:calcite,work:*'
```

New authorization approvals display the namespaces assigned to the OAuth client. Existing OAuth protocols and endpoints are not replaced.

### Observability

Foundation can emit structured JSON or human-readable logs with request IDs. It records bounded in-process metrics for HTTP requests, PostgreSQL queries/transactions, searches, embedding requests/cache hits, and maintenance jobs. Set `METRICS_ENABLED=true` to expose Prometheus text at `/metrics`; when an admin API key is configured, that endpoint requires the admin bearer key.

HTTP probes are separated without removing the old endpoint:

- `/live` checks that the process is alive.
- `/ready` checks database readiness and schema state.
- `/health` remains a compatibility alias for `/ready`.

`foundation_diagnostics` and `foundation-admin diagnostics` report schema, pool, index, embedding, smart-model usage, and maintenance status without returning atom contents.

## Tools

The default `balanced` profile is intentionally small to reduce model tool-schema tokens and tool-selection ambiguity:

| Tool | Purpose | Mutation |
|---|---|---|
| `memory_recall` | Recall relevant active memory | No |
| `memory_remember` | Store durable memory | Yes |
| `memory_update` | Correct one existing memory in place | Yes |
| `memory_replace` | Replace outdated memory while preserving supersession history | Yes |
| `memory_forget` | Reversibly archive one memory | Yes |
| `memory_restore` | Restore a forgotten memory | Yes |

Balanced schemas are deliberately compact. `memory_update` and `memory_replace` need only an atom ID plus replacement text; `memory_forget` and `memory_restore` need only an atom ID. Internal fields are preserved or resolved server-side instead of being sent through the model. `memory_recall` also uses a bounded server-side context budget.

Set `MCP_TOOL_PROFILE=full` when low-level atom or administrative control is needed. Full mode adds the existing `atom_create`, `atom_bulk_create`, `atom_get`, `atom_update`, `atom_search`, `atom_find_similar`, `atom_context`, `atom_delete`, `atom_restore`, `atom_link`, `atom_unlink`, `atom_neighbors`, `atom_merge`, `atom_feedback`, and `atom_supersede` tools. Tools gated by `EXPOSE_MAINTENANCE_TOOLS` remain gated exactly as before.

Example:

```bash
# default; no .env change required
docker compose up -d --build

# temporarily expose the full tool surface
MCP_TOOL_PROFILE=full docker compose up -d --build
```

## Database migrations

The schema is now managed by ordered migrations serialized by a PostgreSQL advisory lock. Current schema version: **5**.

- v1: existing core atom/relation/event schema
- v2: existing OAuth schema
- v3: additive OAuth namespace grants plus `atom_feedback` and `maintenance_jobs`
- v4: additive retrieval/embedding/relation indexes
- v5: maintenance restart hardening and OAuth active-record indexes

No v0.3 migration drops or rewrites the `atoms` table.

With `AUTO_MIGRATE=true`, an existing Foundation MCP v1/v2 database upgrades automatically at startup. A pre-migration Foundation MCP database that already has the known atom columns but lacks migration metadata is conservatively baselined and then upgraded. The older pre-MCP Foundation `atoms_db` format is **not** guessed as the same schema; use the legacy importer described below.

For an explicit migration with an optional `pg_dump` backup:

```bash
npm run build
node dist/src/admin.js migrate foundation-before-v03.dump
```

`pg_dump` must be installed when a backup filename is supplied. If `AUTO_MIGRATE=false`, Foundation refuses to start against an older schema instead of failing later inside a new query.

## Migrating the original Foundation `atoms_db`

The legacy importer reads the old `atoms_db` table and writes through the normal atom validation/deduplication path. Vault/source-sync tables are intentionally ignored.

```bash
npm run build
LEGACY_DATABASE_URL=postgresql://old-host/old-foundation \
DATABASE_URL=postgresql://new-host/foundation \
LEGACY_NAMESPACE=legacy \
npm run migrate:legacy
```

Useful migration controls:

```dotenv
LEGACY_BATCH_SIZE=100
LEGACY_DRY_RUN=false
LEGACY_ATOMIC_BATCH=true
LEGACY_RESUME_AFTER_ID=
```

The importer reports the last processed legacy ID, so an interrupted migration can resume with `LEGACY_RESUME_AFTER_ID`. Setting `LEGACY_DRY_RUN=true` validates and counts records without writing them. With embeddings disabled, migration is fast and embeddings can be backfilled later with `atom_reembed`.

## Portable export, import, and backup

Foundation includes a small operator CLI:

```bash
node dist/src/admin.js diagnostics
node dist/src/admin.js export foundation.jsonl project:calcite
node dist/src/admin.js import foundation.jsonl
node dist/src/admin.js backup foundation.dump
```

Portable JSONL exports omit vectors and derived search documents. Imports recreate atoms through the public atom logic and rebuild relations using an old-ID to new-ID map, so exact deduplication is safe. `backup` uses PostgreSQL `pg_dump --format=custom` for a complete database backup.

## Docker Compose

Copy the example environment and set a real database password and application credentials:

```bash
cp .env.example .env
# Replace POSTGRES_PASSWORD, FOUNDATION_ADMIN_KEY, FOUNDATION_READ_ONLY_KEY,
# and OAuth values as applicable.
docker compose up -d --build
curl http://127.0.0.1:8787/ready
```

The Compose deployment uses a dedicated application image with PostgreSQL 16 client utilities (for version-matched `pg_dump`) and a separate pgvector PostgreSQL 16 container. PostgreSQL is **not** published to the host. The application container is read-only, drops Linux capabilities, enables `no-new-privileges`, and uses `/tmp` as tmpfs.

Data remains in `./data`; `docker compose down` does not delete it.

## Single-container deployment

The original all-in-one `Dockerfile` is retained for users who want PostgreSQL and Foundation in one container. Its entrypoint can generate a random PostgreSQL password when none is supplied, and it continues to translate the common Compose hostname `db` to local PostgreSQL for compatibility.

For reproducible deployments, explicitly provide `POSTGRES_PASSWORD`. The single-container database only listens on loopback inside the container.

## Local stdio

Start a pgvector-enabled PostgreSQL server and run:

```bash
npm install
npm run build
MCP_TRANSPORT=stdio \
DATABASE_URL=postgresql://foundation:password@127.0.0.1:5432/foundation \
EMBEDDING_PROVIDER=none \
node dist/src/index.js
```

No HTTP/OAuth mechanism is required for stdio clients.

## Embeddings

`EMBEDDING_PROVIDER=none` is fully supported. Search then uses PostgreSQL full-text retrieval and trigram similarity.

For OpenAI or a compatible embeddings endpoint:

```dotenv
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
```

For Ollama:

```dotenv
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

The database continues to store unbounded pgvector values while maintaining an HNSW expression index for the active configured dimension. Changing embedding dimensions does not require rebuilding the atom table.

## Retrieval evaluation

A database-backed benchmark runner measures Recall@K, MRR, nDCG@K, latency, and approximate returned token cost:

```bash
npm run build
cp benchmark/example-retrieval.json benchmark/local.json
# Replace the placeholder UUID with real expected atom IDs.
npm run benchmark:retrieval -- benchmark/local.json
```

`npm run benchmark:context` runs a small deterministic context-planning benchmark without a database. Unit tests also cover MMR diversity, token budgets, namespace authorization, and migration ordering.

## Security notes

- `FOUNDATION_ADMIN_KEY` retains full MCP write capability. `FOUNDATION_READ_ONLY_KEY` remains server-enforced read-only.
- Namespace restrictions are optional and default to `*` for backward compatibility.
- OAuth tokens inherit the registered OAuth client's namespace grants; refreshes preserve them.
- Host allow-listing remains enabled for remote HTTP deployments.
- MCP and OAuth endpoints have separate fixed-window request limits.
- Forwarded client-IP and forwarded-host headers are not trusted directly. Rate limiting uses the transport peer; configure proxy-side rate limiting when Foundation is behind a shared reverse proxy.
- Hard deletion still requires a confirmation string equal to the target UUID.
- Retrieved atoms are data, not instructions.
- Use TLS at the reverse proxy for remote deployments.
- Foundation does not hand-roll WebAuthn/OIDC cryptography. If external identity or passkeys are required, terminate identity at a vetted reverse proxy/IdP and keep Foundation's existing OAuth/API mechanisms behind it.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Integration tests run when `TEST_DATABASE_URL` points to a PostgreSQL instance with pgvector. The test suite includes retrieval/context planning, OAuth helpers, namespace authorization, migration safety, transactional atom behavior, supersession, feedback, and atomic/non-atomic bulk creation.
