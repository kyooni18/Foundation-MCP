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
    await database.query("TRUNCATE atom_feedback, atom_events, atom_relations, maintenance_jobs, atoms RESTART IDENTITY CASCADE");
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

    // Arbitrary relation names keep the v0.1 normalization contract; the new
    // standard relation vocabulary must not silently alias old custom names.
    const customRelation = await atoms.link({
      fromAtomID: first.atom.id,
      toAtomID: second.atom.id,
      relationType: "duplicate"
    });
    expect(customRelation.relation_type).toBe("duplicate");
    await atoms.unlink({ fromAtomID: first.atom.id, toAtomID: second.atom.id, relationType: "duplicate" });

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

    await atoms.feedback({ atomID: first.atom.id, signal: 1, reason: "useful retrieval" });
    const context = await atoms.context({ query: "Calcite DS Store", namespace: "project:calcite", mode: "lexical", limit: 5, maxTokens: 200 });
    expect(Number(context.atomCount)).toBeGreaterThan(0);
    expect((await atoms.get(first.atom.id)).access_count).toBeGreaterThan(0);

    const replacement = await atoms.supersede({
      oldAtomID: first.atom.id,
      replacement: { content: "Calcite hides Finder metadata files in the project tree.", namespace: "project:calcite" },
      archiveOld: true
    });
    expect(replacement.relation.relation_type).toBe("supersedes");
    expect((await atoms.get(first.atom.id)).status).toBe("archived");
  });

  it("supports atomic bulk creation without changing legacy partial-success behavior", async () => {
    const base = await atoms.create({ content: "Atomic duplicate sentinel", namespace: "test:bulk" });
    await expect(atoms.bulkCreate([
      { content: "Should roll back with the batch", namespace: "test:bulk" },
      { content: base.atom.content, namespace: "test:bulk", dedupe: "error" }
    ], { atomic: true })).rejects.toThrow(/same normalized content/);
    const search = await atoms.search({ query: "roll back batch", namespace: "test:bulk", mode: "lexical" });
    expect(search.results.some(atom => atom.content === "Should roll back with the batch")).toBe(false);

    const partial = await atoms.bulkCreate([
      { content: "Partial success survives", namespace: "test:bulk" },
      { content: base.atom.content, namespace: "test:bulk", dedupe: "error" }
    ]);
    expect(partial.results[0]?.ok).toBe(true);
    expect(partial.results[1]?.ok).toBe(false);
  });
});
