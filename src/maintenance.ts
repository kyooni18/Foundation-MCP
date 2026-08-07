import type { AtomService } from "./atom-service.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { logger, metrics } from "./telemetry.js";

export type MaintenanceJobType = "oauth_cleanup" | "reembed" | "consolidate" | "archive_expired" | "full";

export class MaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private queued = false;

  constructor(
    private readonly config: Config,
    private readonly atoms: AtomService,
    private readonly database: Database
  ) {}

  start(): void {
    if (!this.config.maintenanceEnabled || this.timer) return;

    // Queued jobs are process-local work. Do not silently replay stale queue
    // entries after a crash because the caller may have already retried them.
    void this.database.query(
      `UPDATE maintenance_jobs SET status='failed', error=COALESCE(error,'server_restarted_before_execution'), finished_at=NOW()
       WHERE status='queued' AND created_at < NOW() - INTERVAL '5 minutes'`
    ).catch(() => undefined);

    const timer = setInterval(() => void this.enqueue("full", { scheduled: true }).catch(error => {
      logger.error("Scheduled maintenance enqueue failed", { error: error instanceof Error ? error.message : String(error) });
    }), this.config.maintenanceIntervalSeconds * 1_000);
    (timer as any).unref?.();
    this.timer = timer;
    void this.enqueue("full", { scheduled: true, initial: true }).catch(error => {
      logger.warn("Initial maintenance enqueue failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Persist a job and return immediately. Execution continues on the next event
   * loop turn, so an MCP request never has to wait for re-embedding or scans.
   */
  async enqueue(jobType: MaintenanceJobType, details: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.running || this.queued) return { accepted: false, reason: "maintenance_already_running" };
    this.queued = true;
    try {
      const queued = await this.database.query<{ id: string }>(
        `INSERT INTO maintenance_jobs (job_type,status,details)
         VALUES ($1,'queued',$2::jsonb) RETURNING id`,
        [jobType, JSON.stringify(details)]
      );
      const jobID = String(queued.rows[0]!.id);
      queueMicrotask(() => void this.executeQueued(jobID, jobType).catch(error => {
        logger.error("Queued maintenance failed", { jobID, jobType, error: error instanceof Error ? error.message : String(error) });
      }));
      return { accepted: true, jobID, status: "queued" };
    } catch (error) {
      this.queued = false;
      throw error;
    }
  }

  /** Synchronous execution for CLI/tests that explicitly need the result. */
  async run(jobType: MaintenanceJobType, details: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.running || this.queued) return { accepted: false, reason: "maintenance_already_running" };
    // Reserve the process-local maintenance slot before the first await so a
    // concurrent enqueue cannot be accepted in the insertion window.
    this.running = true;
    try {
      const inserted = await this.database.query<{ id: string }>(
        `INSERT INTO maintenance_jobs (job_type,status,details,started_at)
         VALUES ($1,'running',$2::jsonb,NOW()) RETURNING id`,
        [jobType, JSON.stringify(details)]
      );
      const jobID = String(inserted.rows[0]!.id);
      const result = await this.executePersisted(jobID, jobType, true);
      return { accepted: true, jobID, status: "succeeded", result };
    } catch (error) {
      // executePersisted owns the slot once it starts; insertion failures do not.
      if (this.running) this.running = false;
      throw error;
    }
  }

  async status(limit = 20): Promise<Record<string, unknown>> {
    const result = await this.database.query(
      `SELECT id,job_type,status,details,result,error,created_at,started_at,finished_at
       FROM maintenance_jobs ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))]
    );
    return { running: this.running, queued: this.queued, jobs: result.rows };
  }

  private async executeQueued(jobID: string, jobType: MaintenanceJobType): Promise<void> {
    this.queued = false;
    if (this.running) {
      await this.database.query(
        "UPDATE maintenance_jobs SET status='failed', error='maintenance_already_running', finished_at=NOW() WHERE id=$1",
        [jobID]
      );
      return;
    }
    // Reserve the slot synchronously before touching PostgreSQL.
    this.running = true;
    try {
      await this.database.query(
        "UPDATE maintenance_jobs SET status='running', started_at=NOW() WHERE id=$1 AND status='queued'",
        [jobID]
      );
      await this.executePersisted(jobID, jobType, true);
    } catch (error) {
      if (this.running) this.running = false;
      throw error;
    }
  }

  private async executePersisted(jobID: string, jobType: MaintenanceJobType, slotReserved = false): Promise<Record<string, unknown>> {
    if (!slotReserved) this.running = true;
    const started = process.hrtime.bigint();
    try {
      const result = await this.execute(jobType);
      await this.database.query(
        "UPDATE maintenance_jobs SET status='succeeded', result=$2::jsonb, finished_at=NOW() WHERE id=$1",
        [jobID, JSON.stringify(result)]
      );
      metrics.increment("maintenance_jobs_succeeded_total");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.query(
        "UPDATE maintenance_jobs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1",
        [jobID, message.slice(0, 4_000)]
      ).catch(() => undefined);
      metrics.increment("maintenance_jobs_failed_total");
      throw error;
    } finally {
      metrics.observe("maintenance_job", Number(process.hrtime.bigint() - started) / 1e9);
      this.running = false;
    }
  }

  private async execute(jobType: MaintenanceJobType): Promise<Record<string, unknown>> {
    if (jobType === "oauth_cleanup") return { oauth: await this.database.cleanupOAuth() };
    if (jobType === "reembed") {
      if (!this.atoms.embeddings.enabled || this.config.maintenanceReembedLimit <= 0) return { reembed: { skipped: true } };
      return { reembed: await this.atoms.reembed({ limit: this.config.maintenanceReembedLimit, onlyMissing: false }) };
    }
    if (jobType === "consolidate") {
      if (this.config.maintenanceConsolidationLimit <= 0) return { consolidate: { skipped: true } };
      return { consolidate: await this.atoms.consolidate({ limit: this.config.maintenanceConsolidationLimit }) };
    }
    if (jobType === "archive_expired") {
      if (!this.config.maintenanceArchiveExpired) return { archiveExpired: { skipped: true, reason: "disabled" } };
      return { archiveExpired: await this.atoms.archiveExpired() };
    }

    const output: Record<string, unknown> = { oauth: await this.database.cleanupOAuth() };
    if (this.atoms.embeddings.enabled && this.config.maintenanceReembedLimit > 0) {
      output.reembed = await this.atoms.reembed({ limit: this.config.maintenanceReembedLimit, onlyMissing: false });
    }
    if (this.config.maintenanceConsolidationLimit > 0) {
      output.consolidate = await this.atoms.consolidate({ limit: this.config.maintenanceConsolidationLimit });
    }
    if (this.config.maintenanceArchiveExpired) output.archiveExpired = await this.atoms.archiveExpired();
    return output;
  }
}
