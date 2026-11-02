/**
 * Stops hammering a service that is down. After `failureThreshold` failures in a row the breaker
 * opens: calls are refused at once, with no waiting, for `cooldownMs`. Then one trial call is let
 * through. If it works the breaker closes; if it fails the breaker stays open for another cooldown.
 *
 * Without it, a calling provider that stops answering makes every click wait for its timeout, and a
 * hundred counsellors clicking at once tie up the server while the provider is already struggling.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /** Whole seconds until a trial call is allowed again, or 0 when calls are allowed. */
  get retryAfterSec(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, Math.ceil((this.openedAt + this.cooldownMs - this.now()) / 1000));
  }

  /**
   * Whether a call may go ahead. Every call that gets a yes must report back with success() or
   * failure(); in the half-open state only one call gets a yes until it has reported.
   */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  failure(): void {
    this.trialInFlight = false;
    this.failures += 1;
    if (this.openedAt !== null || this.failures >= this.failureThreshold) this.openedAt = this.now();
  }
}
