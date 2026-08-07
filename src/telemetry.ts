import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface RequestContext {
  requestID: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export class Logger {
  constructor(
    private readonly format: "text" | "json" = "text",
    private readonly level: LogLevel = "info"
  ) {}

  withRequest<T>(requestID: string | undefined, work: () => T): T {
    return requestContext.run({ requestID: requestID || randomUUID() }, work);
  }

  currentRequestID(): string | null {
    return requestContext.getStore()?.requestID ?? null;
  }

  debug(message: string, fields: Record<string, unknown> = {}): void { this.write("debug", message, fields); }
  info(message: string, fields: Record<string, unknown> = {}): void { this.write("info", message, fields); }
  warn(message: string, fields: Record<string, unknown> = {}): void { this.write("warn", message, fields); }
  error(message: string, fields: Record<string, unknown> = {}): void { this.write("error", message, fields); }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    const weights: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
    if (weights[level] < weights[this.level]) return;
    const requestID = this.currentRequestID();
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(requestID ? { request_id: requestID } : {}),
      ...sanitizeLogFields(fields)
    };
    if (this.format === "json") {
      console.error(JSON.stringify(payload));
      return;
    }
    const details = Object.keys(fields).length ? ` ${JSON.stringify(sanitizeLogFields(fields))}` : "";
    console.error(`${payload.timestamp} ${level.toUpperCase()} ${message}${requestID ? ` request_id=${requestID}` : ""}${details}`);
  }
}

function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const blocked = /authorization|password|secret|token|api[_-]?key|cookie/i;
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    // Numeric token usage counters are observability data, not credentials.
    if (typeof value === "number" && /(?:^|_)tokens?$/.test(key)) return [key, value];
    return [key, blocked.test(key) ? "[redacted]" : value];
  }));
}

interface HistogramState {
  count: number;
  sum: number;
  buckets: number[];
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly histogramBounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

  increment(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  observe(name: string, seconds: number): void {
    const state = this.histograms.get(name) ?? { count: 0, sum: 0, buckets: this.histogramBounds.map(() => 0) };
    state.count += 1;
    state.sum += Math.max(0, seconds);
    for (let index = 0; index < this.histogramBounds.length; index += 1) {
      if (seconds <= this.histogramBounds[index]!) state.buckets[index] = (state.buckets[index] ?? 0) + 1;
    }
    this.histograms.set(name, state);
  }

  async time<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = process.hrtime.bigint();
    try {
      return await work();
    } finally {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      this.observe(name, elapsed);
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries([...this.histograms.entries()].map(([name, value]) => [name, { count: value.count, sum: value.sum }]))
    };
  }

  prometheus(prefix = "foundation"): string {
    const lines: string[] = [];
    for (const [name, value] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# TYPE ${prefix}_${name} counter`, `${prefix}_${name} ${value}`);
    }
    for (const [name, state] of [...this.histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const metric = `${prefix}_${name}_seconds`;
      lines.push(`# TYPE ${metric} histogram`);
      for (let index = 0; index < this.histogramBounds.length; index += 1) {
        lines.push(`${metric}_bucket{le="${this.histogramBounds[index]}"} ${state.buckets[index] ?? 0}`);
      }
      lines.push(`${metric}_bucket{le="+Inf"} ${state.count}`);
      lines.push(`${metric}_sum ${state.sum}`);
      lines.push(`${metric}_count ${state.count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new Metrics();
export let logger = new Logger();

export function configureTelemetry(options: { format: "text" | "json"; level: LogLevel }): void {
  logger = new Logger(options.format, options.level);
}
