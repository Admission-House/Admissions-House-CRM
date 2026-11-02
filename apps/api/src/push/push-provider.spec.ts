import { ExpoPushProvider, PushTransportError, type PushMessage } from './push-provider.js';

const msg = (n: number): PushMessage => ({ to: `ExponentPushToken[${String(n).padStart(12, 'a')}]`, title: `T${n}`, body: 'b', data: { leadId: String(n) } });
const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('ExpoPushProvider', () => {
  it('posts the alerts in the shape the push service expects and maps the tickets back in order', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => reply(200, { data: [{ status: 'ok', id: 'r1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }));
    const results = await new ExpoPushProvider('secret', fetchFn as unknown as typeof fetch).send([msg(1), msg(2)]);

    expect(results).toEqual([{ status: 'ok' }, { status: 'error', dead: true, message: 'gone' }]);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>[];
    expect(sent[0]).toMatchObject({ to: msg(1).to, title: 'T1', body: 'b', data: { leadId: '1' }, sound: 'default', channelId: 'default', priority: 'high', ttl: 3600 });
  });

  it('sends no Authorization header when there is no access token', async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => reply(200, { data: [{ status: 'ok' }] }));
    await new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send([msg(1)]);
    expect((fetchFn.mock.calls[0]![1].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('splits more than 100 alerts into requests of 100 and keeps the order', async () => {
    const sizes: number[] = [];
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      const n = (JSON.parse(init.body as string) as unknown[]).length;
      sizes.push(n);
      return reply(200, { data: Array.from({ length: n }, () => ({ status: 'ok' })) });
    });
    const results = await new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send(Array.from({ length: 250 }, (_, i) => msg(i)));
    expect(sizes).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
  });

  it('treats a refusal other than "phone is gone" as a failed alert, not a dead phone', async () => {
    const fetchFn = vi.fn(() => reply(200, { data: [{ status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }] }));
    expect(await new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send([msg(1)])).toEqual([{ status: 'error', dead: false, message: 'too big' }]);
  });

  it.each([[429, true], [500, true], [503, true], [401, false], [400, false]])('a %i answer is retryable: %s', async (status, retryable) => {
    const fetchFn = vi.fn(() => reply(status, { errors: [{ code: 'X', message: 'nope' }] }));
    await expect(new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send([msg(1)])).rejects.toMatchObject({ name: 'PushTransportError', retryable });
  });

  it('treats a network failure as retryable', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const err = await new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send([msg(1)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushTransportError);
    expect((err as PushTransportError).retryable).toBe(true);
  });

  it('refuses an answer that does not match what was sent, rather than guessing which alert got which result', async () => {
    const fetchFn = vi.fn(() => reply(200, { data: [{ status: 'ok' }] }));
    await expect(new ExpoPushProvider(undefined, fetchFn as unknown as typeof fetch).send([msg(1), msg(2)])).rejects.toMatchObject({ retryable: true });
  });
});
