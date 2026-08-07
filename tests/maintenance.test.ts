import { describe, expect, it } from "vitest";
import type { AtomService } from "../src/atom-service.js";
import type { Config } from "../src/config.js";
import type { Database } from "../src/db.js";
import { MaintenanceService } from "../src/maintenance.js";

describe("maintenance scheduling", () => {
  it("reserves the process slot before asynchronous job startup", async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const database = {
      query: async (sql: string) => {
        if (sql.includes("INSERT INTO maintenance_jobs")) return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        return { rows: [], rowCount: 1 };
      },
      cleanupOAuth: async () => {
        await cleanupGate;
        return { codes: 0, tokens: 0 };
      }
    } as unknown as Database;
    const atoms = { embeddings: { enabled: false } } as unknown as AtomService;
    const config = {
      maintenanceEnabled: false,
      maintenanceIntervalSeconds: 3600,
      maintenanceReembedLimit: 0,
      maintenanceConsolidationLimit: 0,
      maintenanceArchiveExpired: false
    } as Config;
    const maintenance = new MaintenanceService(config, atoms, database);

    const first = await maintenance.enqueue("oauth_cleanup", { test: true });
    await Promise.resolve();
    const second = await maintenance.enqueue("oauth_cleanup", { test: true });
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, reason: "maintenance_already_running" });

    releaseCleanup();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
