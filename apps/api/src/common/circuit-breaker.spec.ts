import { CircuitBreaker } from './circuit-breaker.js';

function make(threshold = 3, cooldownMs = 30_000) {
  let t = 1_000_000;
  const breaker = new CircuitBreaker(threshold, cooldownMs, () => t);
  return { breaker, advance: (ms: number) => { t += ms; } };
}

describe('CircuitBreaker', () => {
  it('lets calls through while it is closed, and a success clears the count', () => {
    const { breaker } = make(3);
    for (let i = 0; i < 2; i++) { expect(breaker.tryAcquire()).toBe(true); breaker.failure(); }
    breaker.success();
    for (let i = 0; i < 2; i++) { expect(breaker.tryAcquire()).toBe(true); breaker.failure(); }
    expect(breaker.state).toBe('closed');
  });

  it('opens after the set number of failures in a row and refuses calls at once', () => {
    const { breaker } = make(3, 30_000);
    for (let i = 0; i < 3; i++) { expect(breaker.tryAcquire()).toBe(true); breaker.failure(); }
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.retryAfterSec).toBe(30);
  });

  it('counts down the time left, and lets one trial call through after the cooldown', () => {
    const { breaker, advance } = make(2, 30_000);
    breaker.failure(); breaker.failure();
    advance(10_000);
    expect(breaker.retryAfterSec).toBe(20);
    expect(breaker.tryAcquire()).toBe(false);

    advance(20_000);
    expect(breaker.state).toBe('half-open');
    expect(breaker.retryAfterSec).toBe(0);
    expect(breaker.tryAcquire()).toBe(true);
    // Only one trial at a time: the others are still turned away until it reports.
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes again when the trial call works', () => {
    const { breaker, advance } = make(2, 30_000);
    breaker.failure(); breaker.failure();
    advance(30_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.success();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('stays open for another full cooldown when the trial call fails', () => {
    const { breaker, advance } = make(2, 30_000);
    breaker.failure(); breaker.failure();
    advance(30_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.failure();
    expect(breaker.state).toBe('open');
    expect(breaker.retryAfterSec).toBe(30);
    advance(29_000);
    expect(breaker.tryAcquire()).toBe(false);
    advance(1_000);
    expect(breaker.tryAcquire()).toBe(true);
  });
});
