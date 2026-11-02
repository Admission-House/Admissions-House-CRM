import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 seconds), the kind every
 * authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password) understands.
 * Pure functions, so they can be checked against the RFC's own test values.
 */

export const STEP_SECONDS = 30;
export const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random shared secret: 20 bytes (160 bits), written in base32 for the authenticator app. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** The code for one counter value (RFC 4226 HOTP). */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Which 30-second step a moment in time falls in. */
export const stepOf = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a typed code. The step before and after the current one are accepted too, because a phone's
 * clock is rarely exact. A step at or before `lastStep` is refused, so a code that was already used
 * (or one older than the last used) cannot be used again. Returns the step that matched, or null.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep: number | null, window = 1): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepOf(nowMs);
  let matched: number | null = null;
  // Every step is checked, so the time taken does not show which one matched.
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    if (same(hotp(secret, step), typed) && (lastStep === null || step > lastStep) && matched === null) matched = step;
  }
  return matched;
}

/** The address an authenticator app reads from the QR code. */
export function otpauthUrl(input: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({ secret: input.secret, issuer: input.issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ------------------------------------------------------------------ recovery codes

/** Letters and digits without look-alikes, so a code can be read out and typed. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A recovery code looks like abcde-23456 (50 bits). */
export function newRecoveryCode(): string {
  const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** What is typed in the code box is a recovery code, not a 6-digit code. */
export const looksLikeRecoveryCode = (typed: string): boolean => /[a-z]/i.test(typed) || typed.includes('-');

const normalizeRecovery = (typed: string): string => typed.toLowerCase().replace(/[\s-]/g, '');

/** Only this hash is stored. 50 random bits are enough that a fast hash is safe here. */
export const hashRecoveryCode = (typed: string): string => createHash('sha256').update(normalizeRecovery(typed)).digest('hex');
