import { lookup } from 'node:dns/promises';

/** A hostname as a router's dynamic DNS service gives it: letters, digits, dots and hyphens, at least one dot or "localhost". */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeHostname(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, '');
  return HOSTNAME.test(h) ? h : null;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; ips: string[] }>();

/**
 * The addresses a hostname points to right now. Remembered for a minute, so a sign-in does not wait for the
 * name server every time, yet a router's new address is picked up quickly. Never throws: a name that does not
 * resolve simply allows nobody.
 */
export async function addressesOf(host: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(host);
  if (hit && now - hit.at < TTL_MS) return hit.ips;
  let ips: string[] = [];
  try {
    const found = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000).unref(),
      ),
    ]);
    ips = found.map((a) => a.address.replace(/^::ffff:/i, ''));
  } catch {
    // Keep the last good answer for a short while rather than locking everyone out on one failed lookup.
    ips = hit && now - hit.at < 10 * TTL_MS ? hit.ips : [];
  }
  cache.set(host, { at: now, ips });
  return ips;
}

/** Whether the request came from the address one of these hostnames points to. */
export async function ddnsMatches(hosts: readonly string[], ip: string): Promise<boolean> {
  const wanted = ip.replace(/^::ffff:/i, '');
  for (const h of hosts) if ((await addressesOf(h)).includes(wanted)) return true;
  return false;
}
