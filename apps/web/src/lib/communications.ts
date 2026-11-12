/** Shapes the calls and meetings API sends, and small helpers the screens share. */

export type CallKind = 'video' | 'voice';

export interface Participant {
  id: string;
  kind: 'staff' | 'guest';
  userId: string | null;
  name: string;
  role: 'host' | 'participant';
  state: 'invited' | 'ringing' | 'accepted' | 'declined' | 'missed' | 'busy' | 'removed';
  connected: boolean;
  firstJoinedAt: string | null;
  lastLeftAt: string | null;
  link?: string;
  deviceBound?: boolean;
}

export interface SessionView {
  id: string;
  type: 'call' | 'meeting';
  kind: CallKind;
  title: string | null;
  description: string | null;
  leadId: string | null;
  leadName: string | null;
  leadNo: string | null;
  createdBy: string;
  createdAt: string;
  scheduledFor: string | null;
  expiresAt: string;
  maxMinutes: number;
  phase: 'planned' | 'ringing' | 'waiting' | 'live' | 'ended';
  status: 'open' | 'ended';
  outcome: 'completed' | 'missed' | 'declined' | 'busy' | 'cancelled' | 'failed' | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  participants: Participant[];
  guestUrl: string | null;
  canManage: boolean;
  recordingStatus: 'not_enabled';
}

export interface SessionDetail extends SessionView {
  events: { event: string; at: string; who: string | null; detail: string | null }[];
}

export interface HistoryItem {
  id: string;
  type: 'call' | 'meeting';
  kind: CallKind;
  title: string | null;
  leadId: string | null;
  leadName: string | null;
  leadNo: string | null;
  createdBy: string;
  createdAt: string;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  phase: SessionView['phase'];
  outcome: SessionView['outcome'];
  peopleInvited: number;
  peopleJoined: number;
  people: string;
  recordingStatus: 'not_enabled';
}

export interface Snapshot {
  status: 'open' | 'ended';
  outcome: string | null;
  secondsLeft: number;
  removed: boolean;
  participants: { name: string; kind: 'staff' | 'guest'; state: string; connected: boolean }[];
}

export interface RtcJoin {
  appId: string;
  channel: string;
  token: string;
  uid: number;
  secondsLeft: number;
  tokenSeconds: number;
  kind: CallKind;
  type: 'call' | 'meeting';
  title: string | null;
}

export type LeaveReason = 'left' | 'time' | 'ended' | 'removed';
export type PresenceEvent = 'joined' | 'ping' | 'left';

/** What happened to a session, in words. */
export const OUTCOME_TEXT: Record<NonNullable<SessionView['outcome']>, string> = {
  completed: 'Completed', missed: 'Missed', declined: 'Declined', busy: 'Busy', cancelled: 'Cancelled', failed: 'Failed',
};

export const PHASE_TEXT: Record<SessionView['phase'], string> = { planned: 'Planned', ringing: 'Ringing', waiting: 'Ready', live: 'Live', ended: 'Ended' };

export const STATE_TEXT: Record<Participant['state'], string> = {
  invited: 'Invited', ringing: 'Ringing', accepted: 'Accepted', declined: 'Declined', missed: 'Missed', busy: 'Busy', removed: 'Removed',
};

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** A random value this browser keeps for one invitation, so the link works from one device only. */
export function deviceIdFor(token: string): string {
  const key = `ah-device-${token.split('.')[1] ?? 'x'}`;
  try {
    const known = localStorage.getItem(key);
    if (known && /^[A-Za-z0-9_-]{24,64}$/.test(known)) return known;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const made = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(key, made);
    return made;
  } catch {
    // Storage blocked: a value for this page view only; the link then works until the page is closed.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
