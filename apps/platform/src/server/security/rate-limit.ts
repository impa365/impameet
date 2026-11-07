/**
 * Fixed-window limiter kept in process memory. Good for a single platform replica; with
 * several replicas each one enforces its own window (move to Postgres/Redis when scaling).
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      this.sweep(t);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(t: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}
