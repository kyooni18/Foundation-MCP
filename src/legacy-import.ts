import pg from "pg";
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import type { AtomCreateInput, AtomKind } from "./types.js";

const { Pool } = pg;

function legacyKind(value: unknown): AtomKind {
  if (value === "aicreated") return "observation";
  if (value === "imported") return "note";
  return "fact";
}

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

async function main(): Promise<void> {
  const legacyURL = process.env.LEGACY_DATABASE_URL;
  if (!legacyURL) throw new Error("LEGACY_DATABASE_URL is required");
  const table = process.env.LEGACY_ATOMS_TABLE ?? "atoms_db";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("LEGACY_ATOMS_TABLE is not a valid SQL identifier");
  const namespace = process.env.LEGACY_NAMESPACE ?? "legacy";
  const batchSize = Math.max(1, Math.min(Number.parseInt(process.env.LEGACY_BATCH_SIZE ?? "500", 10), 5000));
  const dryRun = boolEnv("LEGACY_DRY_RUN");
  const atomicBatch = boolEnv("LEGACY_ATOMIC_BATCH", true);

  const config = loadConfig();
  const target = new Database(config);
  if (!dryRun) await target.initialize();
  const atoms = new AtomService(target, new EmbeddingService(config));
  const legacy = new Pool({ connectionString: legacyURL, max: 2, application_name: "foundation-mcp-legacy-import" });

  let scanned = 0;
  let lastID: string | null = process.env.LEGACY_RESUME_AFTER_ID?.trim() || null;
  let imported = 0;
  let failed = 0;
  try {
    while (true) {
      const result: { rows: Array<Record<string, any>> } = await legacy.query(
        `SELECT * FROM ${table} WHERE ($1::bigint IS NULL OR id > $1::bigint) ORDER BY id LIMIT $2`,
        [lastID, batchSize]
      );
      if (!result.rows.length) break;
      const batch: AtomCreateInput[] = result.rows.map(row => ({
        content: String(row.content ?? ""),
        namespace,
        kind: legacyKind(row.type),
        metadata: typeof row.metadata === "object" && row.metadata !== null ? row.metadata : {},
        source: {
          type: "legacy_foundation",
          legacy_table: table,
          legacy_id: row.id,
          legacy_parent: row.parent ?? null,
          legacy_created_at: row.created_at ?? null
        },
        dedupe: "merge"
      }));

      if (dryRun) {
        for (let index = 0; index < batch.length; index += 1) {
          try {
            atoms.validateCreate(batch[index]!);
            imported += 1;
          } catch (rowError) {
            failed += 1;
            console.error(`Invalid legacy atom ${String(result.rows[index]?.id)}:`, rowError instanceof Error ? rowError.message : rowError);
          }
        }
      } else {
        if (atomicBatch) {
          try {
            const created = await atoms.bulkCreate(batch, { atomic: true });
            imported += created.results.length;
          } catch (error) {
            // Fall back to per-row import so one malformed legacy record does not block the migration.
            for (let index = 0; index < batch.length; index += 1) {
              try {
                await atoms.create(batch[index]!);
                imported += 1;
              } catch (rowError) {
                failed += 1;
                console.error(`Failed to import legacy atom ${String(result.rows[index]?.id)}:`, rowError instanceof Error ? rowError.message : rowError);
              }
            }
          }
        } else {
          const created = await atoms.bulkCreate(batch);
          for (const item of created.results) item.ok ? imported += 1 : failed += 1;
        }
      }
      scanned += result.rows.length;
      lastID = String(result.rows[result.rows.length - 1]!.id);
      console.error(`Legacy import progress: scanned=${scanned} imported=${imported} failed=${failed} last_id=${lastID}${dryRun ? " dry_run=true" : ""}`);
    }
  } finally {
    await legacy.end();
    await target.close();
  }
  console.error(`Legacy import complete: scanned=${scanned} imported=${imported} failed=${failed}${dryRun ? " dry_run=true" : ""}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
