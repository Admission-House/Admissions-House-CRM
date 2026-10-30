/**
 * The office check, as pure functions. The database answers "is this address on an allowed network"
 * (it understands CIDR ranges); everything else is decided here so it can be tested without one.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface LocationReading extends GeoPoint {
  /** Radius of uncertainty reported by the device, in metres. */
  accuracy: number;
  /** True when the device says the position comes from a mock-location app. */
  mocked?: boolean;
}

export interface BranchPosition {
  latitude: string | null;
  longitude: string | null;
  radius_m: number;
}

export type OfficeFailure =
  | 'not_configured'
  | 'network'
  | 'gps_missing'
  | 'gps_mocked'
  | 'gps_inaccurate'
  | 'gps_far';

export type OfficeResult = { ok: true } | { ok: false; reason: OfficeFailure };

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Removes the IPv6 wrapper some servers put around an IPv4 address (::ffff:203.0.113.5). */
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '');
}

export interface OfficeInput {
  branch: BranchPosition;
  /** The branch has at least one allowed network. */
  hasNetworks: boolean;
  /** The request came from one of them. */
  networkMatches: boolean;
  location: LocationReading | undefined;
  maxAccuracyM: number;
}

/**
 * Both checks must pass. An office that has no position or no network set up refuses everyone
 * rather than letting everyone in, so a missing setting can never open the door.
 *
 * The GPS accuracy is not added to the allowed distance: a vague reading is rejected, not excused.
 */
export function evaluateOffice(input: OfficeInput): OfficeResult {
  const { branch, location } = input;
  if (branch.latitude === null || branch.longitude === null || !input.hasNetworks) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!input.networkMatches) return { ok: false, reason: 'network' };

  if (!location) return { ok: false, reason: 'gps_missing' };
  if (location.mocked) return { ok: false, reason: 'gps_mocked' };
  if (!(location.accuracy >= 0) || location.accuracy > input.maxAccuracyM) {
    return { ok: false, reason: 'gps_inaccurate' };
  }
  const distance = distanceMeters(
    { lat: Number(branch.latitude), lng: Number(branch.longitude) },
    { lat: location.lat, lng: location.lng },
  );
  return distance <= branch.radius_m ? { ok: true } : { ok: false, reason: 'gps_far' };
}
