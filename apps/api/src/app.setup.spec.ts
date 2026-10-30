import { requestIdFrom, trustProxyFor } from './app.setup.js';

describe('requestIdFrom', () => {
  it('keeps a well-formed id from the caller', () => {
    expect(requestIdFrom({ 'x-request-id': 'abc-12345678' })).toBe('abc-12345678');
  });

  it.each([
    ['spaces and markup', 'bad id <script>'],
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['a line break', 'abcdefgh\nINJECTED'],
  ])('replaces an id with %s', (_name, value) => {
    const id = requestIdFrom({ 'x-request-id': value });
    expect(id).not.toBe(value);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates an id when none is sent', () => {
    expect(requestIdFrom({})).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('trustProxyFor', () => {
  it('trusts no proxy by default, so X-Forwarded-For is ignored', () => {
    expect(trustProxyFor(0)).toBe(false);
  });

  it('trusts exactly the configured number of proxies', () => {
    const trust = trustProxyFor(1);
    if (typeof trust !== 'function') throw new Error('expected a function');
    expect(trust('10.0.0.1', 0)).toBe(true); // the one proxy we run behind
    expect(trust('203.0.113.9', 1)).toBe(false); // the address it reports is the client, not a proxy
  });
});
