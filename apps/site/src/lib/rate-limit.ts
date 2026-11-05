/**
 * Lets one visitor send only a few requests in a while, so the form cannot be used to flood the
 * CRM with leads. The counts live in this process's memory: a restart clears them, and several
 * servers each keep their own. That is enough for a contact form; a shared store would be needed
 * for anything stricter.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** True if this visitor may go ahead (and the attempt is counted), false if they have used up their share. */
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
  }
}
