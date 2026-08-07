#!/usr/bin/env node
import { createWriteStream, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AtomService } from "./atom-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { EmbeddingService } from "./embeddings.js";
import { jsonText, normalizeNamespacePatterns } from "./utils.js";

async function buildServices() {
  const config = loadConfig();
  const database = new Database(config);
  await database.initialize();
  const atoms = new AtomService(database, new EmbeddingService(config));
  return { config, database, atoms };
}

async function portableExport(database: Database, filename: string | undefined, namespace: string | undefined): Promise<void> {
  const params: unknown[] = [];
  const condition = namespace ? (params.push(namespace), "WHERE namespace=$1") : "";
  const atoms = await database.query(`SELECT * FROM atoms ${condition} ORDER BY created_at,id`, params);
  const atomIDs = atoms.rows.map(row => row.id);
  const relations = atomIDs.length
    ? await database.query("SELECT * FROM atom_relations WHERE from_atom_id=ANY($1::uuid[]) AND to_atom_id=ANY($1::uuid[]) ORDER BY created_at,id", [atomIDs])
    : { rows: [] };
  const output = filename ? createWriteStream(filename, { encoding: "utf8" }) : process.stdout;
  output.write(`${JSON.stringify({ type: "foundation_export", version: 1, exported_at: new Date().toISOString() })}\n`);
  for (const atom of atoms.rows) {
    const { embedding: _embedding, search_document: _searchDocument, ...portable } = atom as Record<string, unknown>;
    output.write(`${JSON.stringify({ type: "atom", atom: portable })}\n`);
  }
  for (const relation of relations.rows) output.write(`${JSON.stringify({ type: "relation", relation })}\n`);
  if (filename) {
    output.end();
    await once(output, "finish");
  }
}

async function portableImport(atoms: AtomService, filename: string, namespaceOverride?: string): Promise<void> {
  const records = String(readFileSync(filename, "utf8")).split(/\r?\n/).filter(Boolean)
    .map((line: string) => JSON.parse(line) as Record<string, any>);
  const atomRecords = records.filter(record => record.type === "atom");
  const relationRecords = records.filter(record => record.type === "relation");
  const idMap = new Map<string, string>();
  let imported = 0;
  for (const record of atomRecords) {
    const atom = record.atom as Record<string, any>;
    const created = await atoms.create({
      content: String(atom.content ?? ""),
      namespace: namespaceOverride ?? String(atom.namespace ?? "default"),
      summary: atom.summary ?? null,
      kind: atom.kind,
      importance: Number(atom.importance ?? 0.5),
      confidence: Number(atom.confidence ?? 1),
      tags: Array.isArray(atom.tags) ? atom.tags.map(String) : [],
      metadata: atom.metadata ?? {},
      source: { ...(atom.source ?? {}), portable_import_original_id: atom.id },
      expiresAt: atom.expires_at ? new Date(atom.expires_at).toISOString() : null,
      dedupe: "merge"
    });
    if (atom.id) idMap.set(String(atom.id), created.atom.id);
    imported += 1;
  }

  let relations = 0;
  for (const record of relationRecords) {
    const relation = record.relation as Record<string, any>;
    const from = idMap.get(String(relation.from_atom_id));
    const to = idMap.get(String(relation.to_atom_id));
    if (!from || !to || from === to) continue;
    await atoms.link({
      fromAtomID: from,
      toAtomID: to,
      relationType: String(relation.relation_type ?? "related_to"),
      weight: Number(relation.weight ?? 1),
      metadata: relation.metadata ?? {}
    });
    relations += 1;
  }
  console.error(`Imported ${imported} portable atoms and ${relations} relations.`);
}

async function pgBackup(databaseURL: string, filename: string): Promise<void> {
  const child = spawn("pg_dump", ["--dbname", databaseURL, "--format=custom", "--no-owner", "--file", filename], { stdio: "inherit" });
  const result = await Promise.race([
    once(child, "exit").then((args: unknown[]) => ({ code: (args[0] ?? null) as number | null, error: null as Error | null })),
    once(child, "error").then((args: unknown[]) => ({ code: null, error: args[0] as Error }))
  ]);
  if (result.error) throw new Error(`Unable to start pg_dump: ${result.error.message}`);
  if (result.code !== 0) throw new Error(`pg_dump exited with status ${String(result.code)}`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help") {
    console.log(`Foundation admin commands:\n  diagnostics\n  migrate [backup.dump]\n  export [file] [namespace]\n  import <file> [namespaceOverride]\n  backup <file.dump>\n  oauth-namespaces <clientID> <pattern1,pattern2,...>\n  consolidate [namespace] [limit]\n`);
    return;
  }
  if (command === "migrate") {
    const before = loadConfig();
    if (args[0]) await pgBackup(before.databaseURL, args[0]);
    process.env.AUTO_MIGRATE = "true";
    const config = loadConfig();
    const database = new Database(config);
    try {
      await database.initialize();
      console.log(jsonText({ migrated: true, schemaVersion: await database.schemaVersion(), backup: args[0] ?? null }));
    } finally {
      await database.close();
    }
    return;
  }

  const { config, database, atoms } = await buildServices();
  try {
    if (command === "diagnostics") {
      console.log(jsonText({ database: await database.health(), indexes: await database.indexHealth(), embedding: atoms.embeddings.stats() }));
      return;
    }
    if (command === "export") {
      await portableExport(database, args[0], args[1]);
      return;
    }
    if (command === "import") {
      if (!args[0]) throw new Error("import requires a filename");
      await portableImport(atoms, args[0], args[1]);
      return;
    }
    if (command === "backup") {
      if (!args[0]) throw new Error("backup requires an output filename");
      await pgBackup(config.databaseURL, args[0]);
      return;
    }
    if (command === "oauth-namespaces") {
      if (!args[0] || !args[1]) throw new Error("oauth-namespaces requires clientID and comma-separated patterns");
      const patterns = normalizeNamespacePatterns(args[1].split(","));
      const result = await database.transaction(async client => {
        const updated = await client.query(
          "UPDATE oauth_clients SET allowed_namespaces=$2 WHERE client_id=$1 RETURNING client_id,client_name,allowed_namespaces",
          [args[0], patterns]
        );
        if (!updated.rows[0]) throw new Error(`OAuth client not found: ${args[0]}`);
        const tokens = await client.query(
          "UPDATE oauth_tokens SET revoked_at=NOW() WHERE client_id=$1 AND revoked_at IS NULL RETURNING token_hash",
          [args[0]]
        );
        const codes = await client.query("DELETE FROM oauth_authorization_codes WHERE client_id=$1 AND used_at IS NULL", [args[0]]);
        return { client: updated.rows[0], revokedTokens: tokens.rowCount ?? 0, removedAuthorizationCodes: codes.rowCount ?? 0 };
      });
      console.log(jsonText(result));
      return;
    }
    if (command === "consolidate") {
      console.log(jsonText(await atoms.consolidate({ namespace: args[0], limit: args[1] ? Number(args[1]) : 100 })));
      return;
    }
    throw new Error(`Unknown admin command: ${command}`);
  } finally {
    await database.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
