import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  it('computes once for the same key until it expires', async () => {
    const cache = new TtlCache<number>(1000);
    const compute = vi.fn(async () => 7);
    expect(await cache.get('a', compute, 0)).toBe(7);
    expect(await cache.get('a', compute, 500)).toBe(7);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await cache.get('a', compute, 5000)).toBe(7);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('never mixes answers between keys', async () => {
    const cache = new TtlCache<string>(1000);
    expect(await cache.get('company1|user1', async () => 'one', 0)).toBe('one');
    expect(await cache.get('company1|user2', async () => 'two', 0)).toBe('two');
  });

  it('shares one computation between requests that ask at the same time', async () => {
    const cache = new TtlCache<number>(1000);
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 1;
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get('k', slow)));
    expect(results.every((v) => v === 1)).toBe(true);
    expect(calls).toBe(1);
  });

  it('does not keep a failure', async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.get('k', async () => { throw new Error('boom'); }, 0)).rejects.toThrow('boom');
    expect(await cache.get('k', async () => 3, 1)).toBe(3);
  });

  it('stays within its size limit', async () => {
    const cache = new TtlCache<number>(100_000, 10);
    for (let i = 0; i < 50; i++) await cache.get(`k${i}`, async () => i, 0);
    const compute = vi.fn(async () => 99);
    await cache.get('k49', compute, 1);
    expect(compute.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
