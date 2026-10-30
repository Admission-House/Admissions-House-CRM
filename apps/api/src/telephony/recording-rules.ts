import { isIP } from 'node:net';

/**
 * True for an address that must never be fetched on a user's behalf: this machine, the local
 * network, link-local (including cloud metadata at 169.254.169.254) and other reserved ranges.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address; // IPv4 inside IPv6
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * A recording may only be fetched from a host the company named in its connection, over https, on
 * the standard port, with no embedded login. `insecure` relaxes the scheme and port for tests.
 */
export function checkRecordingUrl(raw: string, allowedHosts: readonly string[], insecure = false): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid address' };
  }
  if (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:')) return { ok: false, reason: 'must use https' };
  if (url.username || url.password) return { ok: false, reason: 'must not contain a login' };
  if (url.port && !insecure) return { ok: false, reason: 'must use the standard port' };
  if (!allowedHosts.includes(url.hostname.toLowerCase())) return { ok: false, reason: `host ${url.hostname} is not allowed for recordings` };
  return { ok: true, url };
}

export interface AudioKind {
  ext: 'mp3' | 'wav' | 'ogg' | 'm4a';
  mime: string;
}

/** What audio a file is, from its first bytes. Anything else is refused, whatever the server called it. */
export function sniffAudio(head: Buffer): AudioKind | null {
  if (head.length < 12) return null;
  if (head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  return null;
}
