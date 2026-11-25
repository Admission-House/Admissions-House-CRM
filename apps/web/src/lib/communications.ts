/** Shapes the calls and meetings API sends, and small helpers the screens share. */

export type CallKind = 'video' | 'voice';

export type RecordingState =
  | 'off'
  | 'unavailable'
  | 'pending'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'processing'
  | 'available'
  | 'failed'
  | 'expired';

/** Short words for the history table and the room. */
export const RECORDING_TEXT: Record<RecordingState, string> = {
  off: 'Off',
  unavailable: 'Not possible',
  pending: 'Starting',
  starting: 'Starting',
  recording: 'Recording',
  stopping: 'Saving',
  processing: 'Saving',
  available: 'Ready',
  failed: 'Failed',
  expired: 'Removed',
};

export interface RecordingPolicy {
  mode: 'off' | 'optional' | 'always';
  retentionDays: number;
  noticeText: string;
  version: number;
  ready: boolean;
  missing?: string[];
}

export interface RecordingFile {
  id: string;
  kind: 'audio' | 'video' | 'audio_and_video';
  format: 'mp4' | 'mp3' | 'm3u8' | 'ts';
  sizeBytes: number | null;
  playable: boolean;
}
export interface RecordingItem {
  id: string;
  status: RecordingState;
  failureReason: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  availableAt: string | null;
  expiresAt: string | null;
  files: RecordingFile[];
  canPlay: boolean;
  canDownload: boolean;
}

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
  recordingStatus: RecordingState;
  recordingEnabled: boolean;
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
  recordingStatus: RecordingState;
}

export interface Snapshot {
  status: 'open' | 'ended';
  outcome: string | null;
  secondsLeft: number;
  removed: boolean;
  participants: { name: string; kind: 'staff' | 'guest'; state: string; connected: boolean }[];
  recording?: { status: RecordingState; botUid: number | null };
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
  recordingEnabled?: boolean;
}

/** What the student's page shows before they press Join: who is calling, and whether the call is still open. */
export interface GuestInfo {
  companyName: string;
  hostName: string;
  guestName: string;
  kind: CallKind;
  title: string | null;
  ended: boolean;
}

/** A WhatsApp link: to a number, or, with no number, to a chat the person picks. The text is filled in but not sent. */
export function whatsappLink(phone: string | null | undefined, text?: string): string {
  return `https://wa.me/${(phone ?? '').replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const firstName = (name: string, fallback: string): string =>
  name.trim().split(/\s+/)[0] || fallback;

/**
 * The WhatsApp message that carries a student's link: who is writing and from where, so it does not look like a
 * message from a stranger. The name is the counsellor who sends it.
 */
export function joinMessage(p: {
  guest: string;
  host: string;
  company: string;
  kind: CallKind;
  link: string;
}): string {
  const what = p.kind === 'voice' ? 'voice' : 'video';
  return `Hello ${firstName(p.guest, 'there')}, this is ${firstName(p.host, 'your counsellor')} from ${p.company || 'Admissions House'}. Please open this link to join your counselling ${what} call:\n${p.link}`;
}

/** The words on the student's page before they join. */
export function greetingFor(info: GuestInfo | 'invalid' | null): {
  company: string;
  title: string;
  text: string;
  closed: boolean;
} {
  if (info === 'invalid')
    return {
      company: 'Admissions House',
      title: 'This link is not valid',
      text: 'This link is not valid. Please use the link you were sent. If it was changed or cancelled, ask for a new one.',
      closed: true,
    };
  if (!info)
    return {
      company: 'Admissions House',
      title: 'You are invited to a session',
      text: 'Press the button below when you are ready, and allow your microphone when your browser asks.',
      closed: false,
    };
  const first = firstName(info.guestName, 'there');
  const company = info.companyName || 'Admissions House';
  if (info.ended)
    return {
      company,
      title: 'This session has ended',
      text: `Please contact ${info.hostName} for a new link.`,
      closed: true,
    };
  const call = info.kind === 'voice' ? 'voice' : 'video';
  return {
    company,
    title: `Hello ${first}, your counselling session is ready`,
    text: `${info.hostName} from ${company} is waiting for you on a ${call} call. Press the button below and allow your microphone${info.kind === 'video' ? ' and camera' : ''} when your browser asks.`,
    closed: false,
  };
}

export type LeaveReason = 'left' | 'time' | 'ended' | 'removed';
export type PresenceEvent = 'joined' | 'ping' | 'left';

/** What happened to a session, in words. */
export const OUTCOME_TEXT: Record<NonNullable<SessionView['outcome']>, string> = {
  completed: 'Completed',
  missed: 'Missed',
  declined: 'Declined',
  busy: 'Busy',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const PHASE_TEXT: Record<SessionView['phase'], string> = {
  planned: 'Planned',
  ringing: 'Ringing',
  waiting: 'Ready',
  live: 'Live',
  ended: 'Ended',
};

export const STATE_TEXT: Record<Participant['state'], string> = {
  invited: 'Invited',
  ringing: 'Ringing',
  accepted: 'Accepted',
  declined: 'Declined',
  missed: 'Missed',
  busy: 'Busy',
  removed: 'Removed',
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
    const made = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    localStorage.setItem(key, made);
    return made;
  } catch {
    // Storage blocked: a value for this page view only; the link then works until the page is closed.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}
