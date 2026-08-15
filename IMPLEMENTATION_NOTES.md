# Foundation MCP v0.3 Improvement Implementation Notes

This revision implements the improvement roadmap with compatibility as the primary constraint.

## Compatibility guarantees

- All 18 pre-existing MCP tool names are preserved.
- `foundation-about`, `foundation-stats`, and `foundation-memory-policy` are preserved.
- HTTP stateless MCP, stdio MCP, API-key auth, read-only API keys, OAuth authorization-code + PKCE, dynamic registration, refresh tokens, and revocation remain available.
- Existing tool input schemas are unchanged except for two optional additions: `atom_bulk_create.atomic` and `atom_context.maxTokens`.
- Existing arbitrary relation strings keep the v0.1 normalization behavior; the new standard relation vocabulary is additive only.
- `/health` remains available as a compatibility readiness endpoint.

## Database compatibility

The core `atoms`, `atom_relations`, and `atom_events` model is not redesigned. Schema versions 3-5 are additive:

- namespace grants on the existing OAuth records;
- `atom_feedback` for explicit retrieval feedback;
- `maintenance_jobs` for persistent maintenance status;
- additive retrieval, relation, and OAuth indexes.

Existing Foundation MCP v1/v2 databases are upgraded in place through ordered migrations. Older pre-MCP Foundation databases using `atoms_db` continue to use the dedicated importer, now with dry-run, atomic-batch, and resume controls.

For cautious upgrades, run:

```bash
npm run build
node dist/src/admin.js migrate foundation-before-v03.dump
```

For the old `atoms_db` format, use `LEGACY_DATABASE_URL` and `npm run migrate:legacy`; see README.md for all controls.

## Major additions

- two-stage hybrid candidate retrieval and reranking;
- MMR-style context diversity, query decomposition, relation expansion, token budgets, and summary fallback;
- adaptive access and explicit feedback signals with intentionally small ranking weights;
- embedding batching, duplicate suppression, cache, bounded concurrency, retries, and stale-signature re-embedding;
- Google Gemini and OpenRouter embedding providers with provider-specific request/response handling;
- bounded embedding network timeouts, transient-error retry classification, `Retry-After` support, and lexical fallback for hybrid searches;
- transactional atom mutation + audit behavior and opt-in atomic bulk writes;
- explicit supersession and conservative near-duplicate consolidation suggestions;
- lifecycle review/promotion/decay suggestions without automatic destructive mutation;
- namespace authorization layered over the existing API-key/OAuth mechanisms;
- request/OAuth rate limiting, request IDs, structured logs, metrics, liveness/readiness, and diagnostics;
- persisted background maintenance jobs;
- operator CLI for diagnostics, migration/backup, portable export/import, OAuth namespace grants, and consolidation;
- hardened split-container deployment while retaining the original all-in-one image;
- retrieval benchmark tooling and expanded tests.

## Deliberate compatibility/security choices

- PostgreSQL Row Level Security and a new user/tenant schema were not introduced because they would substantially redesign the database. Namespace grants provide isolation at the existing credential layer instead.
- WebAuthn/passkey and external OIDC cryptography are not hand-rolled inside Foundation. A vetted IdP/reverse proxy can provide those identity methods while Foundation retains its existing OAuth/API mechanisms behind it.
- Consolidation never automatically merges or deletes near-duplicates; it creates auditable `duplicate_of` suggestions. Contradictions remain explicit typed relations rather than heuristic guesses.

## Validation performed in this environment

- strict TypeScript checking of all source and test files passed using temporary external type stubs for unavailable packages;
- all original MCP tool/resource/prompt names were compared against the uploaded source and preserved;
- deterministic context-planning benchmark executed successfully with 10,000 candidates and 50 selections;
- pure runtime checks passed for embedding batching/cache, migration ordering, rate limiting, context budgeting, and summary fallback;
- `docker-compose.yml` parsed successfully as YAML;
- `package.json` parsed successfully as JSON;
- `container-entrypoint.sh` passed `bash -n`;
- post-v2 migration definitions were checked for core `atoms` table drop/drop-column operations.

The full npm/Vitest/PostgreSQL integration suite could not be executed in the current build environment because the project dependencies and PostgreSQL/pgvector runtime are not installed and the available npm registry did not provide the required MCP SDK package. The CI workflow remains configured to run the real suite against pgvector PostgreSQL 16 once dependencies are available.
## Smart-model cost optimization

This revision adds a deterministic-first compatibility layer for the existing smart-memory configuration. Existing `.env` files require no changes: the historical `SMART_MODEL_ENABLED`, `SMART_MODEL`, `SMART_MODEL_API_KEY`, and `SMART_MODEL_BASE_URL` variables continue to work, while all new cost controls have code defaults. No database migration is introduced by this change.

- recall/context reads never invoke the smart generative model;
- simple writes, obvious list/sentence splits, and strong lexical duplicates are resolved deterministically;
- duplicate/change candidate discovery is lexical-only before the smart fallback, avoiding an extra embedding-provider call solely for gating;
- ambiguous writes make at most one structured smart-model request;
- repeated decisions are cached by input plus candidate IDs/versions;
- smart prompts cap source text and candidate content, use bounded structured output and low reasoning effort, and request `store: false`;
- failures, timeouts, unavailable credentials, and exhausted usage budgets fall back to deterministic storage;
- default in-process safeguards are 32 smart calls/day, 24,000 estimated input tokens/day, 3,200 input characters/request, and 320 output tokens/request;
- health/diagnostics expose aggregate call, avoidance, cache, failure, and token counters without exposing atom contents.

The budgets are intentionally in-process and require no schema change. A process restart resets them, so deployments that require a provider-enforced monetary ceiling should also configure a billing/provider hard limit.
