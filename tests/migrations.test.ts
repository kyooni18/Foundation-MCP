import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrations } from "../src/migrations.js";

describe("database migrations", () => {
  it("are strictly ordered and end at the advertised schema version", () => {
    const versions = migrations.map(migration => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.at(-1)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("keep post-v2 changes additive", () => {
    const sql = migrations.filter(migration => migration.version > 2).flatMap(migration => migration.statements(1536)).join("\n").toLowerCase();
    expect(sql).not.toMatch(/drop\s+table\s+atoms/);
    expect(sql).not.toMatch(/alter\s+table\s+atoms\s+drop\s+column/);
  });

  it("adds lifecycle states without rewriting existing atom contents", () => {
    const lifecycle = migrations.find(migration => migration.version === 6);
    expect(lifecycle?.name).toBe("atom-lifecycle-states");
    const sql = lifecycle?.statements(1536).join("\n").toLowerCase() ?? "";
    for (const status of ["active", "resolved", "superseded", "deprecated", "archived", "deleted"]) {
      expect(sql).toContain(`'${status}'`);
    }
    expect(sql).toContain("relation_type='supersedes'");
    expect(sql).toContain("a.status='archived'");
    expect(sql).not.toMatch(/delete\s+from\s+atoms/);
  });
});
