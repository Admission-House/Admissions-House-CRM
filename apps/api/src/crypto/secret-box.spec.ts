import { SecretBox } from './secret-box.js';

const box = new SecretBox({ DATA_ENCRYPTION_KEY: 'ab'.repeat(32) });

describe('SecretBox', () => {
  it('gives back what was sealed, including non-English text and the empty string', () => {
    for (const text of ['api-key-123', 'सिया', '', 'x'.repeat(5000), '{"token":"a.b.c"}']) {
      expect(box.open(box.seal(text, 'row-1'), 'row-1')).toBe(text);
    }
  });

  it('seals the same text differently each time and never shows it', () => {
    const a = box.seal('secret-value', 'row-1');
    const b = box.seal('secret-value', 'row-1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-value');
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
  });

  it('refuses text that was changed', () => {
    const [v, iv, tag, data] = box.seal('secret-value', 'row-1').split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => box.open([v, iv, tag, flipped.toString('base64url')].join('.'), 'row-1')).toThrow();
    expect(() => box.open([v, iv, 'AAAAAAAAAAAAAAAAAAAAAA', data].join('.'), 'row-1')).toThrow();
  });

  it('refuses a value moved to another place', () => {
    expect(() => box.open(box.seal('secret-value', 'tenant-a:config'), 'tenant-b:config')).toThrow();
  });

  it('refuses a value sealed with another key, or not sealed at all', () => {
    const other = new SecretBox({ DATA_ENCRYPTION_KEY: 'cd'.repeat(32) });
    expect(() => other.open(box.seal('secret-value', 'c'), 'c')).toThrow();
    for (const bad of ['', 'plain text', 'v2.a.b.c', 'v1.a.b', 'v1.a.b.c.d']) expect(() => box.open(bad, 'c')).toThrow();
  });
});
