import { isIP } from 'node:net';
import { AppError } from '../common/app-error.js';

const MIN_PREFIX = { 4: 16, 6: 48 } as const;

/**
 * Checks an allowed network typed by a person and returns it in CIDR form. A single address
 * becomes /32 (or /128). A range wider than a /16 (IPv4) or /48 (IPv6) is refused: an office does
 * not own that many addresses, and a range like 0.0.0.0/0 would switch the network check off.
 */
export function normalizeAllowedRange(input: string): string {
  const [address, prefixText, ...rest] = input.trim().split('/');
  const version = address ? isIP(address) : 0;
  const bad = (message: string) => AppError.badRequest('NETWORK_INVALID', message, [{ field: 'ipRange', message }]);

  if (rest.length > 0 || (version !== 4 && version !== 6)) {
    throw bad('Enter an IP address such as 203.0.113.5, or a range such as 203.0.113.0/28');
  }
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || !/^\d{1,3}$/.test(prefixText ?? '0') || prefix < 0 || prefix > max) {
    throw bad(`The range size must be a whole number up to ${max}`);
  }
  if (prefix < MIN_PREFIX[version]) {
    throw bad(`That range is too wide. Use /${MIN_PREFIX[version]} or narrower.`);
  }
  return `${address}/${prefix}`;
}

/** The single-address range for the address a request came from. */
export function rangeForAddress(ip: string): string {
  return normalizeAllowedRange(ip.replace(/^::ffff:/i, ''));
}

/**
 * True for addresses that are only meaningful inside a network (private, loopback, link-local).
 * If the API sees one of these as the client address, it is looking at a proxy or the local
 * machine rather than the office's public address, and saving it would not protect anything.
 */
export function isInternalAddress(ip: string): boolean {
  const a = ip.replace(/^::ffff:/i, '').toLowerCase();
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return p === 10 || p === 127 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
}
