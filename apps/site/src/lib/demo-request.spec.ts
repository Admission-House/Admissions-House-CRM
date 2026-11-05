import { describe, expect, it } from 'vitest';
import { demoRequestSchema, normalisePhone, TEAM_SIZES, toLead } from './demo-request';
import { RateLimiter } from './rate-limit';
import { formatPhone } from './site';

const valid = { name: 'Meena Rao', email: 'Meena@Example.com', phone: '98765 43210', company: 'Rao Education', teamSize: TEAM_SIZES[1], city: 'Pune', message: 'We use spreadsheets today.' };

describe('mobile numbers', () => {
  it('accept the ways people type them', () => {
    for (const text of ['9876543210', '98765 43210', '+91 98765 43210', '+91-98765-43210', '09876543210', '91 9876543210']) expect(normalisePhone(text), text).toBe('9876543210');
  });

  it('refuse numbers that cannot be a mobile number', () => {
    for (const text of ['', '12345', '5876543210', '98765432', '98765432101', 'call me']) expect(normalisePhone(text), text).toBeNull();
  });
});

describe('the demo request form', () => {
  it('accepts a complete request', () => {
    expect(demoRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('needs name, email, phone, company and team size, and says which is missing', () => {
    const res = demoRequestSchema.safeParse({ name: '', email: 'nope', phone: '123', company: '', teamSize: 'a few' });
    expect(res.success).toBe(false);
    const fields = res.success ? [] : res.error.issues.map((i) => String(i.path[0])).sort();
    expect(fields).toEqual(['company', 'email', 'name', 'phone', 'teamSize']);
  });

  it('does not need a city or a message', () => {
    const { city: _city, message: _message, ...minimal } = valid;
    expect(demoRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('refuses a message that is far too long', () => {
    expect(demoRequestSchema.safeParse({ ...valid, message: 'x'.repeat(601) }).success).toBe(false);
  });
});

describe('the lead sent to the CRM', () => {
  const lead = toLead(demoRequestSchema.parse(valid), { id: 'demo-1', now: new Date('2026-11-05T10:00:00Z') });

  it('carries the contact details in the shape the CRM intake reads', () => {
    expect(lead).toMatchObject({ id: 'demo-1', createdAt: '2026-11-05T10:00:00.000Z', name: 'Meena Rao', phone: '9876543210', email: 'meena@example.com', city: 'Pune', source: 'product-demo-request', page: '/demo' });
  });

  it('puts the company, team size and message where a counsellor reads them first', () => {
    expect(lead.interest).toBe('Demo request from Rao Education. 11 to 30 counsellors. We use spreadsheets today.');
  });

  it('keeps the interest text inside the 300 characters the CRM keeps', () => {
    const long = toLead(demoRequestSchema.parse({ ...valid, message: 'y'.repeat(600) }), { id: 'demo-2', now: new Date() });
    expect(long.interest.length).toBeLessThanOrEqual(300);
    expect(long.interest.endsWith('…')).toBe(true);
  });

  it('leaves out an empty city', () => {
    const noCity = toLead(demoRequestSchema.parse({ ...valid, city: '' }), { id: 'demo-3', now: new Date() });
    expect('city' in noCity).toBe(false);
  });
});

describe('the rate limit', () => {
  it('lets a visitor send a few requests and then asks them to wait', () => {
    const limit = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3, 4].map((i) => limit.allow('ip-a', t + i))).toEqual([true, true, true, false]);
    expect(limit.allow('ip-b', t + 5)).toBe(true);
  });

  it('lets them back in once the window has passed', () => {
    const limit = new RateLimiter(1, 60_000);
    expect(limit.allow('ip', 0)).toBe(true);
    expect(limit.allow('ip', 30_000)).toBe(false);
    expect(limit.allow('ip', 60_001)).toBe(true);
  });
});

describe('phone numbers on the page', () => {
  it('are written the Indian way', () => {
    expect(formatPhone('+918796648777')).toBe('+91 87966 48777');
    expect(formatPhone('+14155550100')).toBe('+14155550100');
  });
});
