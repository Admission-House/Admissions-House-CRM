import { createHmac, timingSafeEqual } from 'node:crypto';
import agora from 'agora-token';

/** How long an outside guest's link works after the session's chosen start (or its creation): a day. */
export const LINK_HOURS = 24;
/** A staff member may open a planned meeting this long before its start. */
export const EARLY_JOIN_MINUTES = 10;
/** A join token lives this long and is renewed while the person is still allowed to be in the call. */
export const RTC_TOKEN_SECONDS = 300;
/** A screen that has not reported for this long is taken to have left (closed the tab, lost the network). */
export const PRESENCE_STALE_SECONDS = 45;
/** After everyone has left, a call (not a meeting) is ended once this many seconds pass. */
export const EMPTY_CALL_GRACE_SECONDS = 90;
/** A planned meeting reminds its staff this many minutes ahead. */
export const REMINDER_MINUTES = 10;

/** What kind of media a session carries. */
export type SessionKind = 'video' | 'voice';
/** A call is one-to-one; a meeting is planned, may have a title and many people. */
export type SessionType = 'call' | 'meeting';
export type InviteState = 'invited' | 'ringing' | 'accepted' | 'declined' | 'missed' | 'busy' | 'removed';
export type Outcome = 'completed' | 'missed' | 'declined' | 'busy' | 'cancelled' | 'failed';

/** At least this many people are counted in a call, whoever has joined so far. */
export const MIN_PEOPLE_IN_CALL = 2;

/**
 * Agora's free package is counted in "Standard minutes". Each person-minute costs 1 for sound only and
 * 4 for video up to 1280x720, which includes every size this app uses (Agora pricing page).
 */
export const STANDARD_PER_PERSON_MINUTE: Record<SessionKind, number> = { voice: 1, video: 4 };

/** Standard minutes used by one minute of a call of this kind with this many people. */
export const standardPerCallMinute = (kind: SessionKind, people: number = MIN_PEOPLE_IN_CALL): number =>
  Math.max(people, MIN_PEOPLE_IN_CALL) * STANDARD_PER_PERSON_MINUTE[kind];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INVITE_TOKEN = new RegExp(`^(${UUID})\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`, 'i');

/** The Agora channel of a session. Agora allows letters and digits, up to 64 bytes. Nothing about the people is in it. */
export const channelOf = (sessionId: string): string => `ah${sessionId.replace(/-/g, '')}`;

const mac = (secret: string, tenantId: string, inviteId: string, version: number): string =>
  createHmac('sha256', secret).update(`invite:${tenantId}:${inviteId}:${version}`).digest('base64url');

/**
 * The secret part of a guest's link. It belongs to one invitation and one version of it: whoever holds it
 * can join that one session as that one guest, nothing else. Raising the version cancels older links.
 */
export const inviteToken = (secret: string, tenantId: string, inviteId: string, version: number): string =>
  `${tenantId}.${inviteId}.${mac(secret, tenantId, inviteId, version)}`;

export interface ParsedInviteToken {
  tenantId: string;
  inviteId: string;
  mac: string;
}

/** The parts of a link, if it has the right shape. Whether it is genuine is decided with the invitation's version. */
export function parseInviteToken(token: string): ParsedInviteToken | null {
  const m = INVITE_TOKEN.exec(token);
  return m ? { tenantId: m[1]!.toLowerCase(), inviteId: m[2]!.toLowerCase(), mac: m[3]! } : null;
}

/** Whether the link was made for this invitation at this version. */
export function inviteTokenGenuine(secret: string, parsed: ParsedInviteToken, version: number): boolean {
  const given = Buffer.from(parsed.mac);
  const expected = Buffer.from(mac(secret, parsed.tenantId, parsed.inviteId, version));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A number for one person in one channel: Agora wants a 32-bit unsigned integer from 1. */
export const randomUid = (random: (max: number) => number): number => 1 + random(2_147_483_646);

/**
 * A join token for one person and one channel, valid for `seconds` (never more than the session has left).
 * It is renewed while the person is still allowed in, so ending a session or removing someone takes effect
 * within one token life even for a screen that stays open.
 */
export function buildRtcToken(appId: string, certificate: string, channel: string, uid: number, seconds: number): string {
  const life = Math.max(30, Math.floor(seconds));
  return agora.RtcTokenBuilder.buildTokenWithUid(appId, certificate, channel, uid, agora.RtcRole.PUBLISHER, life, life);
}

export interface SessionClock {
  status: string;
  started_at: Date | string | null;
  scheduled_for?: Date | string | null;
  max_minutes: number;
  expires_at: Date | string;
  ended_at: Date | string | null;
}

export type SessionProblem = 'ended' | 'link_expired' | 'time_up' | 'too_early' | null;

/** Why a session cannot be joined right now, or null when it can. */
export function sessionProblem(s: SessionClock, now: Date): SessionProblem {
  if (s.status === 'ended' || s.ended_at) return 'ended';
  if (s.started_at) {
    const end = new Date(s.started_at).getTime() + s.max_minutes * 60_000;
    if (now.getTime() >= end) return 'time_up';
    return null;
  }
  if (now.getTime() >= new Date(s.expires_at).getTime()) return 'link_expired';
  if (s.scheduled_for && now.getTime() < new Date(s.scheduled_for).getTime() - EARLY_JOIN_MINUTES * 60_000) return 'too_early';
  return null;
}

/** Seconds of call time left. A session that has not started has all of it. */
export function secondsLeft(s: Pick<SessionClock, 'started_at' | 'max_minutes'>, now: Date): number {
  if (!s.started_at) return s.max_minutes * 60;
  return Math.max(0, Math.floor((new Date(s.started_at).getTime() + s.max_minutes * 60_000 - now.getTime()) / 1000));
}

/** Whether someone's screen has reported recently enough to count as connected. */
export function isConnected(i: { joined_at: Date | string | null; last_seen_at: Date | string | null }, now: Date): boolean {
  if (!i.joined_at || !i.last_seen_at) return false;
  return now.getTime() - new Date(i.last_seen_at).getTime() < PRESENCE_STALE_SECONDS * 1000;
}
