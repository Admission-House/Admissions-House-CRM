/**
 * The rules behind a person's own settings, kept apart from the database so they can be tested on their own.
 */

/** Pages a person may choose to land on after signing in, and what they must be allowed to do to see each one. */
export const START_PAGES = {
  dashboard: ['dashboard.read'],
  leads: ['lead.read'],
  communications: ['video.host'],
  reports: ['report.read'],
  attendance: ['attendance.self', 'attendance.read'],
} as const;
export type StartPage = keyof typeof START_PAGES;
export const START_PAGE_KEYS = Object.keys(START_PAGES) as [StartPage, ...StartPage[]];

/** The pages this person may pick: those they are allowed to open. */
export function allowedStartPages(permissions: ReadonlySet<string>): StartPage[] {
  return START_PAGE_KEYS.filter((page) => START_PAGES[page].some((p) => permissions.has(p)));
}

/**
 * The kinds of alert a person can switch off. Security alerts and system messages are not listed: they are always on,
 * because a Super Admin who switched off sign-in alerts would stop hearing about a break-in.
 */
export const NOTIFY_KINDS = ['leads', 'calls', 'approvals'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const KIND_OF: Record<string, NotifyKind | undefined> = {
  lead_new: 'leads',
  assignment: 'leads',
  followup_due: 'leads',
  communication: 'calls',
  approval: 'approvals',
};

/** Which switch controls an alert of this type. Undefined means it cannot be switched off. */
export const kindOfAlert = (type: string): NotifyKind | undefined => KIND_OF[type];

// ------------------------------------------------------------------ the profile photo

export const AVATAR_MAX_BYTES = 64 * 1024;
export type AvatarType = 'image/jpeg' | 'image/png' | 'image/webp';

/** What the first bytes of each kind of picture look like. The word the browser sends is never trusted on its own. */
function typeOfBytes(b: Buffer): AvatarType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type AvatarCheck = { ok: true; bytes: Buffer; type: AvatarType } | { ok: false; reason: string };

/**
 * A picture as the browser sends it ("data:image/jpeg;base64,..."). Only JPEG, PNG and WebP, small, and the bytes
 * themselves must be that kind of picture. SVG and anything else that can carry a script is refused.
 */
export function checkAvatar(dataUrl: string): AvatarCheck {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return { ok: false, reason: 'Choose a JPEG, PNG or WebP picture.' };
  const claimed = m[1] as AvatarType;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'The picture is empty.' };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, reason: 'The picture is too large. Choose a smaller one.' };
  const real = typeOfBytes(bytes);
  if (!real || real !== claimed) return { ok: false, reason: 'This file is not a valid picture.' };
  return { ok: true, bytes, type: real };
}
