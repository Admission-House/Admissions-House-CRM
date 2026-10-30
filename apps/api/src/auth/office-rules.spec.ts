import { distanceMeters, evaluateOffice, normalizeIp, OfficeInput } from './office-rules.js';

// The Admissions House office, Greater Noida West.
const OFFICE = { lat: 28.6021, lng: 77.4309 };

const ready: OfficeInput = {
  branch: { latitude: String(OFFICE.lat), longitude: String(OFFICE.lng), radius_m: 200 },
  hasNetworks: true,
  networkMatches: true,
  location: { ...OFFICE, accuracy: 20 },
  maxAccuracyM: 150,
};

/** A point roughly `metres` north of the office. One degree of latitude is about 111,195 m. */
const northOf = (metres: number) => ({ lat: OFFICE.lat + metres / 111_195, lng: OFFICE.lng });

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(OFFICE, OFFICE)).toBe(0);
  });

  it('measures a known short distance', () => {
    expect(distanceMeters(OFFICE, northOf(100))).toBeCloseTo(100, 0);
    expect(distanceMeters(OFFICE, northOf(1000))).toBeCloseTo(1000, -1);
  });

  it('measures a known long distance (Delhi to Mumbai is about 1,150 km)', () => {
    const km = distanceMeters({ lat: 28.6139, lng: 77.209 }, { lat: 19.076, lng: 72.8777 }) / 1000;
    expect(km).toBeGreaterThan(1130);
    expect(km).toBeLessThan(1170);
  });
});

describe('normalizeIp', () => {
  it('unwraps an IPv4 address carried in IPv6', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });
  it('leaves other addresses alone', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('evaluateOffice', () => {
  it('accepts a request on the office network and inside the radius', () => {
    expect(evaluateOffice(ready)).toEqual({ ok: true });
  });

  it('accepts a position just inside the radius and refuses one just outside', () => {
    expect(evaluateOffice({ ...ready, location: { ...northOf(190), accuracy: 10 } })).toEqual({ ok: true });
    expect(evaluateOffice({ ...ready, location: { ...northOf(215), accuracy: 10 } })).toEqual({ ok: false, reason: 'gps_far' });
  });

  it('needs both checks: the right network alone is not enough', () => {
    expect(evaluateOffice({ ...ready, location: undefined })).toEqual({ ok: false, reason: 'gps_missing' });
    expect(evaluateOffice({ ...ready, location: { ...northOf(5000), accuracy: 10 } })).toEqual({ ok: false, reason: 'gps_far' });
  });

  it('needs both checks: a good position alone is not enough', () => {
    expect(evaluateOffice({ ...ready, networkMatches: false })).toEqual({ ok: false, reason: 'network' });
  });

  it('refuses a vague reading even when its centre is inside the radius', () => {
    expect(evaluateOffice({ ...ready, location: { ...OFFICE, accuracy: 400 } })).toEqual({ ok: false, reason: 'gps_inaccurate' });
  });

  it('refuses a nonsense accuracy value', () => {
    expect(evaluateOffice({ ...ready, location: { ...OFFICE, accuracy: -1 } })).toEqual({ ok: false, reason: 'gps_inaccurate' });
    expect(evaluateOffice({ ...ready, location: { ...OFFICE, accuracy: Number.NaN } })).toEqual({ ok: false, reason: 'gps_inaccurate' });
  });

  it('refuses a position the device says is mocked', () => {
    expect(evaluateOffice({ ...ready, location: { ...OFFICE, accuracy: 5, mocked: true } })).toEqual({ ok: false, reason: 'gps_mocked' });
  });

  describe('an office that is not set up refuses everyone (fails closed)', () => {
    it('no position', () => {
      const branch = { latitude: null, longitude: null, radius_m: 200 };
      expect(evaluateOffice({ ...ready, branch })).toEqual({ ok: false, reason: 'not_configured' });
    });
    it('no allowed network', () => {
      expect(evaluateOffice({ ...ready, hasNetworks: false })).toEqual({ ok: false, reason: 'not_configured' });
    });
  });
});
