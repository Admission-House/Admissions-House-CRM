import { allowedStartPages, AVATAR_MAX_BYTES, checkAvatar, kindOfAlert } from './preferences-rules.js';

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
const url = (type: string, b: Buffer) => `data:${type};base64,${b.toString('base64')}`;

describe('profile photo check', () => {
  it('accepts a real JPEG, PNG and WebP', () => {
    expect(checkAvatar(url('image/jpeg', jpeg))).toMatchObject({ ok: true, type: 'image/jpeg' });
    expect(checkAvatar(url('image/png', png))).toMatchObject({ ok: true, type: 'image/png' });
    expect(checkAvatar(url('image/webp', webp))).toMatchObject({ ok: true, type: 'image/webp' });
  });
  it('refuses SVG, other types and text that is not a data URL', () => {
    expect(checkAvatar(`data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`).ok).toBe(false);
    expect(checkAvatar('https://example.test/a.jpg').ok).toBe(false);
    expect(checkAvatar('data:text/html;base64,PGI+').ok).toBe(false);
  });
  it('refuses bytes that are not the kind of picture they claim to be', () => {
    expect(checkAvatar(url('image/png', jpeg)).ok).toBe(false);
    expect(checkAvatar(url('image/jpeg', Buffer.from('<script>alert(1)</script>'))).ok).toBe(false);
  });
  it('refuses a picture over the size limit', () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(AVATAR_MAX_BYTES)]);
    expect(checkAvatar(url('image/jpeg', big)).ok).toBe(false);
  });
});

describe('start pages and alert kinds', () => {
  it('offers only pages the person may open', () => {
    expect(allowedStartPages(new Set(['lead.read', 'dashboard.read']))).toEqual(['dashboard', 'leads']);
    expect(allowedStartPages(new Set())).toEqual([]);
  });
  it('lets leads, calls and approvals be switched off, never security or system alerts', () => {
    expect(kindOfAlert('lead_new')).toBe('leads');
    expect(kindOfAlert('communication')).toBe('calls');
    expect(kindOfAlert('approval')).toBe('approvals');
    expect(kindOfAlert('security')).toBeUndefined();
    expect(kindOfAlert('system')).toBeUndefined();
  });
});
