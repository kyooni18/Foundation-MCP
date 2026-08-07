export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000
  ) {}

  consume(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    if (this.limit <= 0) return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, resetAt: Date.now() + this.windowMs };
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) this.sweep(now);
    return { allowed: entry.count <= this.limit, remaining: Math.max(0, this.limit - entry.count), resetAt: entry.resetAt };
  }

  private sweep(now: number): void {
    for (const [key, value] of this.entries) if (value.resetAt <= now) this.entries.delete(key);
  }
}
