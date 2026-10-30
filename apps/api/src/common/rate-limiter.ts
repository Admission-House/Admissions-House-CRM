/**
 * A sliding-window counter kept in this process. It is a cheap first gate in front of expensive
 * work (password hashing). It protects one server only; the per-address count in the database
 * is the shared, durable limit.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records an attempt. Returns 0 if allowed, otherwise the seconds to wait. */
  hit(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
    // Still too many distinct callers: drop the oldest half rather than grow without limit.
    if (this.hits.size > this.maxKeys) {
      let drop = Math.ceil(this.hits.size / 2);
      for (const key of this.hits.keys()) {
        if (drop-- <= 0) break;
        this.hits.delete(key);
      }
    }
  }
}
