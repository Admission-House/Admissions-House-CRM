import { buildExotelConnection } from './env-connection.js';

const GOOD = {
  EXOTEL_ACCOUNT_SID: 'acme1',
  EXOTEL_API_KEY: 'key-abc',
  EXOTEL_API_TOKEN: 'token-def-ghi',
  EXOTEL_CALLER_ID: '08012345678',
  PUBLIC_API_URL: 'https://crm.example.com/api/v1/',
};

describe('Exotel settings from the environment', () => {
  it('makes the stored settings and the address for Exotel, with a new webhook key', () => {
    const c = buildExotelConnection(GOOD);
    expect(c.config).toMatchObject({ accountSid: 'acme1', apiKey: 'key-abc', apiToken: 'token-def-ghi', callerId: '08012345678', host: 'api.exotel.com', record: true });
    expect(c.webhookKey).toMatch(/^ahw_[A-Za-z0-9_-]{43}$/);
    expect(c.callbackUrl).toBe(`https://crm.example.com/api/v1/telephony/hooks/exotel/${c.webhookKey}`);
    expect(c.config.callbackUrl).toBe(c.callbackUrl);
    expect(c.recordingHosts).toEqual([]);
  });

  it('keeps an existing webhook key, and replaces one that is not in the right shape', () => {
    const first = buildExotelConnection(GOOD);
    expect(buildExotelConnection(GOOD, first.webhookKey).webhookKey).toBe(first.webhookKey);
    expect(buildExotelConnection(GOOD, 'not-a-key').webhookKey).not.toBe('not-a-key');
  });

  it('reads the optional settings', () => {
    const c = buildExotelConnection({ ...GOOD, EXOTEL_HOST: 'api.in.exotel.com', EXOTEL_RECORD: 'false', EXOTEL_RECORDING_HOSTS: 'Recordings.Example.com, rec2.example.com' });
    expect(c.config).toMatchObject({ host: 'api.in.exotel.com', record: false });
    expect(c.recordingHosts).toEqual(['recordings.example.com', 'rec2.example.com']);
  });

  it('names what is missing or wrong, and never repeats a value', () => {
    expect(() => buildExotelConnection({ ...GOOD, EXOTEL_API_TOKEN: '' })).toThrow(/EXOTEL_API_TOKEN is missing/);
    expect(() => buildExotelConnection({ ...GOOD, EXOTEL_API_KEY: undefined })).toThrow(/EXOTEL_API_KEY is missing/);
    expect(() => buildExotelConnection({ ...GOOD, EXOTEL_HOST: 'evil.example.net' })).toThrow(/EXOTEL_HOST/);
    expect(() => buildExotelConnection({ ...GOOD, PUBLIC_API_URL: 'http://crm.example.com/api/v1' })).toThrow(/PUBLIC_API_URL is not valid/);
    expect(() => buildExotelConnection({ ...GOOD, EXOTEL_RECORDING_HOSTS: 'not a host!' })).toThrow(/EXOTEL_RECORDING_HOSTS/);
    let message = '';
    try {
      buildExotelConnection({ ...GOOD, EXOTEL_API_TOKEN: 'SECRET-TOKEN-VALUE', PUBLIC_API_URL: 'ftp://x' });
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('accepts a plain http address only for the developer machine', () => {
    expect(buildExotelConnection({ ...GOOD, PUBLIC_API_URL: 'http://localhost:3001/api/v1' }).callbackUrl).toMatch(/^http:\/\/localhost:3001\/api\/v1\/telephony\/hooks\/exotel\/ahw_/);
  });
});
