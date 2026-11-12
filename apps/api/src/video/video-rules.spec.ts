import { randomUUID } from 'node:crypto';
import { buildRtcToken, channelOf, guestToken, randomUid, readGuestToken, secondsLeft, sessionProblem } from './video-rules.js';

const SECRET = 'a-test-secret-that-is-long-enough-123456';
const tenant = randomUUID();
const session = randomUUID();

describe('the student link', () => {
  it('reads back the company and session it was made for', () => {
    expect(readGuestToken(SECRET, guestToken(SECRET, tenant, session))).toEqual({ tenantId: tenant, sessionId: session });
  });

  it('is the same every time, so it can be copied again later', () => {
    expect(guestToken(SECRET, tenant, session)).toBe(guestToken(SECRET, tenant, session));
  });

  it('is refused when any part is changed or the secret differs', () => {
    const link = guestToken(SECRET, tenant, session);
    expect(readGuestToken('another-secret-another-secret-another', link)).toBeNull();
    expect(readGuestToken(SECRET, `${tenant}.${randomUUID()}.${link.split('.')[2]}`)).toBeNull();
    expect(readGuestToken(SECRET, `${randomUUID()}.${session}.${link.split('.')[2]}`)).toBeNull();
    expect(readGuestToken(SECRET, link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(readGuestToken(SECRET, 'nonsense')).toBeNull();
    expect(readGuestToken(SECRET, '')).toBeNull();
  });
});

describe('the Agora channel and token', () => {
  it('makes a channel name Agora accepts (letters and digits, under 64 bytes)', () => {
    const channel = channelOf(session);
    expect(channel).toMatch(/^[A-Za-z0-9]+$/);
    expect(Buffer.byteLength(channel)).toBeLessThan(64);
  });

  it('picks a uid Agora accepts: a 32-bit unsigned integer of at least 1', () => {
    expect(randomUid(() => 0)).toBe(1);
    expect(randomUid((max) => max - 1)).toBe(2_147_483_646);
    for (let i = 0; i < 50; i++) {
      const uid = randomUid((max) => Math.floor(Math.random() * max));
      expect(uid).toBeGreaterThanOrEqual(1);
      expect(uid).toBeLessThanOrEqual(4_294_967_295);
    }
  });

  it('builds a version 007 token that differs by person and channel', () => {
    const appId = '0123456789abcdef0123456789abcdef';
    const cert = 'fedcba9876543210fedcba9876543210';
    const a = buildRtcToken(appId, cert, channelOf(session), 11, 600);
    expect(a.startsWith('007')).toBe(true);
    expect(buildRtcToken(appId, cert, channelOf(session), 12, 600)).not.toBe(a);
    expect(buildRtcToken(appId, cert, channelOf(randomUUID()), 11, 600)).not.toBe(a);
  });
});

describe('when a session can be joined', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  const base = { status: 'open', started_at: null, max_minutes: 45, expires_at: new Date('2026-11-13T10:00:00Z'), ended_at: null };

  it('is open before and during the call', () => {
    expect(sessionProblem(base, now)).toBeNull();
    expect(sessionProblem({ ...base, started_at: new Date('2026-11-12T09:30:00Z') }, now)).toBeNull();
  });

  it('refuses an ended session', () => {
    expect(sessionProblem({ ...base, status: 'ended', ended_at: now }, now)).toBe('ended');
  });

  it('refuses a link that expired before anyone joined, but not a call already running', () => {
    expect(sessionProblem({ ...base, expires_at: new Date('2026-11-12T09:00:00Z') }, now)).toBe('link_expired');
    expect(sessionProblem({ ...base, expires_at: new Date('2026-11-12T09:00:00Z'), started_at: new Date('2026-11-12T09:50:00Z') }, now)).toBeNull();
  });

  it('refuses once the agreed minutes have passed', () => {
    expect(sessionProblem({ ...base, started_at: new Date('2026-11-12T09:14:00Z') }, now)).toBe('time_up');
  });

  it('counts the seconds left from the start', () => {
    expect(secondsLeft({ started_at: null, max_minutes: 45 }, now)).toBe(2700);
    expect(secondsLeft({ started_at: new Date('2026-11-12T09:40:00Z'), max_minutes: 45 }, now)).toBe(1500);
    expect(secondsLeft({ started_at: new Date('2026-11-12T08:00:00Z'), max_minutes: 45 }, now)).toBe(0);
  });
});
