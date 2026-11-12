import { createHmac, timingSafeEqual } from 'node:crypto';
import agora from 'agora-token';

/** How long the student's link works when no time was chosen: a day. */
export const LINK_HOURS = 24;
/** Counted as two people in a call when the monthly usage is estimated. */
export const PEOPLE_IN_CALL = 2;
/**
 * Agora's free package is counted in "Standard minutes", and video up to 1280x720 (which includes
 * every size this app uses) costs 4 of them for each person-minute (Agora pricing, Video HD 1:4).
 */
export const VIDEO_STANDARD_RATIO = 4;
/** Standard minutes used by one minute of a video call. */
export const STANDARD_PER_CALL_MINUTE = PEOPLE_IN_CALL * VIDEO_STANDARD_RATIO;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const GUEST_TOKEN = new RegExp(`^(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

/** The Agora channel of a session. Agora allows letters and digits, up to 64 bytes. */
export const channelOf = (sessionId: string): string => `ah${sessionId.replace(/-/g, '')}`;

const mac = (secret: string, tenantId: string, sessionId: string): string =>
  createHmac('sha256', secret).update(`video-guest:${tenantId}:${sessionId}`).digest('base64url');

/** The secret part of the student's link. Anyone who holds it can join that one session, nothing else. */
export const guestToken = (secret: string, tenantId: string, sessionId: string): string =>
  `${tenantId}.${sessionId}.${mac(secret, tenantId, sessionId)}`;

/** The company and session in a link, if the link is genuine; otherwise null. */
export function readGuestToken(secret: string, token: string): { tenantId: string; sessionId: string } | null {
  const m = GUEST_TOKEN.exec(token);
  if (!m) return null;
  const tenantId = m[1]!.toLowerCase();
  const sessionId = m[2]!.toLowerCase();
  const given = Buffer.from(m[3]!);
  const expected = Buffer.from(mac(secret, tenantId, sessionId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? { tenantId, sessionId } : null;
}

/** A number that is unique enough inside one channel: Agora wants a 32-bit unsigned integer from 1. */
export const randomUid = (random: (max: number) => number): number => 1 + random(2_147_483_646);

/**
 * A join token for one person and one channel. Both its life and the permission to publish end when
 * the session's time is up, so nobody can stay in a call beyond the agreed length.
 */
export function buildRtcToken(appId: string, certificate: string, channel: string, uid: number, secondsLeft: number): string {
  const seconds = Math.max(60, Math.floor(secondsLeft));
  return agora.RtcTokenBuilder.buildTokenWithUid(appId, certificate, channel, uid, agora.RtcRole.PUBLISHER, seconds, seconds);
}

export interface SessionClock {
  status: string;
  started_at: Date | string | null;
  max_minutes: number;
  expires_at: Date | string;
  ended_at: Date | string | null;
}

export type SessionProblem = 'ended' | 'link_expired' | 'time_up' | null;

/** Why a session cannot be joined right now, or null when it can. */
export function sessionProblem(s: SessionClock, now: Date): SessionProblem {
  if (s.status === 'ended' || s.ended_at) return 'ended';
  if (s.started_at) {
    const end = new Date(s.started_at).getTime() + s.max_minutes * 60_000;
    if (now.getTime() >= end) return 'time_up';
  } else if (now.getTime() >= new Date(s.expires_at).getTime()) {
    return 'link_expired';
  }
  return null;
}

/** Seconds of call time left. A session that has not started has all of it. */
export function secondsLeft(s: Pick<SessionClock, 'started_at' | 'max_minutes'>, now: Date): number {
  if (!s.started_at) return s.max_minutes * 60;
  return Math.max(0, Math.floor((new Date(s.started_at).getTime() + s.max_minutes * 60_000 - now.getTime()) / 1000));
}
