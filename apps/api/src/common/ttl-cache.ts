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
  private generation = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 2_000,
  ) {}

  async get(key: string, compute: () => Promise<T>, now = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value;

    const running = this.pending.get(key);
    if (running) return running;

    const generation = this.generation;
    const started = compute().then(
      (value) => {
        if (this.pending.get(key) === started) this.pending.delete(key);
        // An answer worked out before a change was reported is already out of date: use it once, do not keep it.
        if (generation === this.generation) {
          // Spread the expiry a little so entries made together do not all expire together.
          this.entries.set(key, { value, expires: now + this.ttlMs + Math.floor(Math.random() * this.ttlMs * 0.2) });
          if (this.entries.size > this.maxKeys) this.prune(now);
        }
        return value;
      },
      (err: unknown) => {
        if (this.pending.get(key) === started) this.pending.delete(key);
        throw err;
      },
    );
    this.pending.set(key, started);
    return started;
  }

  /** Forgets every answer whose key starts with `prefix` (an empty prefix forgets all of them). */
  invalidate(prefix: string): void {
    this.generation += 1;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
    for (const key of [...this.pending.keys()]) if (key.startsWith(prefix)) this.pending.delete(key);
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
