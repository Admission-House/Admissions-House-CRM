/**
 * A small in-process cache for answers that are expensive to compute and fine to be a few seconds
 * old. Two properties matter more than speed:
 *
 *  - The key must hold everything that changes the answer (company, who is asking, their scope), so
 *    one person can never be given another person's numbers. The caller builds the key.
 *  - Many requests asking at once share one computation, so a burst of dashboards cannot become a
 *    burst of identical heavy queries.
 *
 * It lives in this process only. With several servers each keeps its own copy, which is harmless
 * for numbers that expire in seconds. A failed computation is not cached.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 2_000,
  ) {}

  async get(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;

    const running = this.pending.get(key);
    if (running) return running;

    const started = compute().then(
      (value) => {
        this.pending.delete(key);
        // Spread the expiry a little so entries made together do not all expire together.
        this.entries.set(key, { value, expires: now + this.ttlMs + Math.floor(Math.random() * this.ttlMs * 0.2) });
        if (this.entries.size > this.maxKeys) this.prune(now);
        return value;
      },
      (err: unknown) => {
        this.pending.delete(key);
        throw err;
      },
    );
    this.pending.set(key, started);
    return started;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    // Still too many: forget the oldest half rather than grow without limit.
    let drop = this.entries.size > this.maxKeys ? Math.ceil(this.entries.size / 2) : 0;
    for (const key of this.entries.keys()) {
      if (drop-- <= 0) break;
      this.entries.delete(key);
    }
  }
}
