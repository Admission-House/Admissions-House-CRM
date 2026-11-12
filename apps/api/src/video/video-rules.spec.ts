import { randomUUID } from 'node:crypto';
import {
  buildRtcToken, channelOf, inviteToken, inviteTokenGenuine, isConnected, parseInviteToken, randomUid, secondsLeft, sessionProblem, standardPerCallMinute,
} from './video-rules.js';

const SECRET = 'a-test-secret-that-is-long-enough-123456';
const tenant = randomUUID();
const invite = randomUUID();

describe('a guest\'s link', () => {
  it('names the company and the invitation it was made for, and is genuine at its version', () => {
    const parsed = parseInviteToken(inviteToken(SECRET, tenant, invite, 1))!;
    expect(parsed).toMatchObject({ tenantId: tenant, inviteId: invite });
    expect(inviteTokenGenuine(SECRET, parsed, 1)).toBe(true);
  });

  it('is the same every time for the same version, so it can be copied again later', () => {
    expect(inviteToken(SECRET, tenant, invite, 3)).toBe(inviteToken(SECRET, tenant, invite, 3));
  });

  it('stops working when the version is raised, and for any other invitation, company or secret', () => {
    const link = inviteToken(SECRET, tenant, invite, 1);
    const parsed = parseInviteToken(link)!;
    expect(inviteTokenGenuine(SECRET, parsed, 2)).toBe(false);
    expect(inviteTokenGenuine('another-secret-another-secret-another', parsed, 1)).toBe(false);
    expect(inviteTokenGenuine(SECRET, { ...parsed, inviteId: randomUUID() }, 1)).toBe(false);
    expect(inviteTokenGenuine(SECRET, { ...parsed, tenantId: randomUUID() }, 1)).toBe(false);
    const altered = parseInviteToken(link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A'))!;
    expect(inviteTokenGenuine(SECRET, altered, 1)).toBe(false);
  });

  it('is refused when it has the wrong shape', () => {
    for (const bad of ['', 'nonsense', `${tenant}.${invite}`, `${tenant}.${invite}.short`, `x.${invite}.${'A'.repeat(43)}`]) expect(parseInviteToken(bad)).toBeNull();
  });

  it('gives different links to different invitations of the same session', () => {
    expect(inviteToken(SECRET, tenant, randomUUID(), 1)).not.toBe(inviteToken(SECRET, tenant, randomUUID(), 1));
  });
});

describe('the Agora channel and token', () => {
  it('makes a channel name Agora accepts (letters and digits, under 64 bytes) with nothing about the people in it', () => {
    const session = randomUUID();
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
    const a = buildRtcToken(appId, cert, channelOf(invite), 11, 300);
    expect(a.startsWith('007')).toBe(true);
    expect(buildRtcToken(appId, cert, channelOf(invite), 12, 300)).not.toBe(a);
    expect(buildRtcToken(appId, cert, channelOf(randomUUID()), 11, 300)).not.toBe(a);
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

  it('keeps a planned meeting closed until a few minutes before its time', () => {
    expect(sessionProblem({ ...base, scheduled_for: new Date('2026-11-12T11:00:00Z') }, now)).toBe('too_early');
    expect(sessionProblem({ ...base, scheduled_for: new Date('2026-11-12T10:09:00Z') }, now)).toBeNull();
    expect(sessionProblem({ ...base, scheduled_for: new Date('2026-11-12T09:30:00Z') }, now)).toBeNull();
  });

  it('counts the seconds left from the start', () => {
    expect(secondsLeft({ started_at: null, max_minutes: 45 }, now)).toBe(2700);
    expect(secondsLeft({ started_at: new Date('2026-11-12T09:40:00Z'), max_minutes: 45 }, now)).toBe(1500);
    expect(secondsLeft({ started_at: new Date('2026-11-12T08:00:00Z'), max_minutes: 45 }, now)).toBe(0);
  });
});

describe('who counts as connected', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  it('needs to have joined and to have reported recently', () => {
    expect(isConnected({ joined_at: new Date('2026-11-12T09:50:00Z'), last_seen_at: new Date('2026-11-12T09:59:40Z') }, now)).toBe(true);
    expect(isConnected({ joined_at: new Date('2026-11-12T09:50:00Z'), last_seen_at: new Date('2026-11-12T09:58:00Z') }, now)).toBe(false);
    expect(isConnected({ joined_at: null, last_seen_at: new Date('2026-11-12T09:59:55Z') }, now)).toBe(false);
    expect(isConnected({ joined_at: new Date('2026-11-12T09:50:00Z'), last_seen_at: null }, now)).toBe(false);
  });
});

describe('Agora minutes', () => {
  it('counts a voice call at 1 per person-minute and a video call at 4, for at least two people', () => {
    expect(standardPerCallMinute('voice')).toBe(2);
    expect(standardPerCallMinute('video')).toBe(8);
    expect(standardPerCallMinute('video', 1)).toBe(8);
    expect(standardPerCallMinute('video', 5)).toBe(20);
    expect(standardPerCallMinute('voice', 3)).toBe(3);
  });
});
