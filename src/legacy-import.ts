import pg from "pg";
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import type { AtomKind } from "./types.js";

const { Pool } = pg;

function legacyKind(value: unknown): AtomKind {
  if (value === "aicreated") return "observation";
  if (value === "imported") return "note";
  return "fact";
}

async function main(): Promise<void> {
  const legacyURL = process.env.LEGACY_DATABASE_URL;
  if (!legacyURL) throw new Error("LEGACY_DATABASE_URL is required");
  const table = process.env.LEGACY_ATOMS_TABLE ?? "atoms_db";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("LEGACY_ATOMS_TABLE is not a valid SQL identifier");
  const namespace = process.env.LEGACY_NAMESPACE ?? "legacy";
  const batchSize = Math.max(1, Math.min(Number.parseInt(process.env.LEGACY_BATCH_SIZE ?? "500", 10), 5000));

  const config = loadConfig();
  const target = new Database(config);
  await target.initialize();
  const atoms = new AtomService(target, new EmbeddingService(config));
  const legacy = new Pool({ connectionString: legacyURL, max: 2, application_name: "foundation-mcp-legacy-import" });

  let scanned = 0;
  let lastID: string | null = null;
  let imported = 0;
  let failed = 0;
  try {
    while (true) {
      const result: { rows: Array<Record<string, any>> } = await legacy.query(
        `SELECT * FROM ${table} WHERE ($1::bigint IS NULL OR id > $1::bigint) ORDER BY id LIMIT $2`,
        [lastID, batchSize]
      );
      if (!result.rows.length) break;
      for (const row of result.rows) {
        try {
          await atoms.create({
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
          });
          imported += 1;
        } catch (error) {
          failed += 1;
          console.error(`Failed to import legacy atom ${String(row.id)}:`, error instanceof Error ? error.message : error);
        }
      }
      scanned += result.rows.length;
      lastID = String(result.rows[result.rows.length - 1]!.id);
      console.error(`Legacy import progress: scanned=${scanned} imported=${imported} failed=${failed}`);
    }
  } finally {
    await legacy.end();
    await target.close();
  }
  console.error(`Legacy import complete: scanned=${scanned} imported=${imported} failed=${failed}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
