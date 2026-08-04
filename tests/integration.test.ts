import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AtomService } from "../src/atom-service.js";
import { loadConfig } from "../src/config.js";
import { Database } from "../src/db.js";
import { EmbeddingService } from "../src/embeddings.js";

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;

integration("Foundation MCP PostgreSQL integration", () => {
  let database: Database;
  let atoms: AtomService;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.EMBEDDING_PROVIDER = "none";
    process.env.AUTO_MIGRATE = "true";
    process.env.ENABLE_AUDIT = "true";

    const config = loadConfig();
    database = new Database(config);
    await database.initialize();
    await database.query("TRUNCATE atom_events, atom_relations, atoms RESTART IDENTITY CASCADE");
    atoms = new AtomService(database, new EmbeddingService(config));
  });

  afterAll(async () => {
    await database?.close();
  });

  it("creates, deduplicates, searches, versions, relates, merges, and restores atoms", async () => {
    const first = await atoms.create({
      content: "The Calcite editor hides .DS_Store files.",
      namespace: "project:calcite",
      tags: ["macOS", "file tree"],
      importance: 0.8
    });
    expect(first.created).toBe(true);

    const duplicate = await atoms.create({
      content: "  The Calcite editor hides .DS_Store files.  ",
      namespace: "project:calcite",
      tags: ["Swift"]
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.atom.id).toBe(first.atom.id);
    expect(duplicate.atom.tags).toEqual(["file-tree", "macos", "swift"]);

    const search = await atoms.search({
      query: "Calcite DS_Store",
      namespace: "project:calcite",
      mode: "lexical"
    });
    expect(search.results[0]?.id).toBe(first.atom.id);

    const updated = await atoms.update({
      id: first.atom.id,
      expectedVersion: duplicate.atom.version,
      summary: "Project tree filtering decision"
    });
    expect(updated.version).toBe(duplicate.atom.version + 1);

    await expect(atoms.update({
      id: first.atom.id,
      expectedVersion: duplicate.atom.version,
      confidence: 0.9
    })).rejects.toThrow(/Version conflict/);

    const second = await atoms.create({
      content: "Calcite uses a SwiftUI project tree.",
      namespace: "project:calcite",
      tags: ["swiftui"]
    });

    const relation = await atoms.link({
      fromAtomID: first.atom.id,
      toAtomID: second.atom.id,
      relationType: "related to"
    });
    expect(relation.relation_type).toBe("related_to");
    expect((await atoms.neighbors(first.atom.id)).length).toBe(1);
    await atoms.unlink({
      fromAtomID: first.atom.id,
      toAtomID: second.atom.id,
      relationType: "related to"
    });
    expect((await atoms.neighbors(first.atom.id)).length).toBe(0);

    await atoms.link({
      fromAtomID: second.atom.id,
      toAtomID: first.atom.id,
      relationType: "supports"
    });
    const merged = await atoms.merge({
      targetAtomID: first.atom.id,
      sourceAtomIDs: [second.atom.id]
    });
    expect(merged.atom.tags).toContain("swiftui");
    expect((await atoms.get(second.atom.id)).status).toBe("archived");

    await atoms.remove(first.atom.id, "archive");
    expect((await atoms.get(first.atom.id)).status).toBe("archived");
    expect((await atoms.restore(first.atom.id)).status).toBe("active");
    expect((await atoms.history(first.atom.id)).length).toBeGreaterThan(0);
  });
});
