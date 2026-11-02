import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderPayloadError } from '../call-events.js';
import { exotelTime, ExotelProvider } from './exotel.provider.js';
import { safeUrl } from '../../app.module.js';

const p = new ExotelProvider();
const config = {
  accountSid: 'acme', apiKey: 'key123', apiToken: 'token123', callerId: '08012345678',
  callbackUrl: 'https://crm.example.com/api/v1/telephony/hooks/exotel/ahw_abcdefghijklmnopqrstuvwxyz',
};

describe('Exotel status callback', () => {
  const done = { CallSid: 'sid1', Status: 'completed', EventType: 'terminal', DateCreated: '2024-01-15 14:25:10', From: '09876543210', To: '09123456789', StartTime: '2024-01-15 14:25:12', EndTime: '2024-01-15 14:30:45', ConversationDuration: 320, Direction: 'outbound-api', RecordingUrl: 'https://s3-ap-southeast-1.amazonaws.com/x/rec.mp3' };

  it('turns a talked call into ended and recording events, with the customer as the number called', () => {
    const [ended, rec] = p.normalize(done);
    expect(ended).toMatchObject({ providerCallId: 'sid1', event: 'ended', direction: 'outgoing', customerNumber: '919123456789', agentNumber: '919876543210', durationSec: 320 });
    expect(ended!.at.toISOString()).toBe('2024-01-15T09:00:45.000Z'); // 14:30:45 at +05:30
    expect(rec).toMatchObject({ event: 'recording', recordingUrl: done.RecordingUrl });
  });

  it('treats a completed call with no conversation as not picked', () => {
    expect(p.normalize({ ...done, ConversationDuration: 0, RecordingUrl: null })).toMatchObject([{ event: 'ended', durationSec: 0, outcome: 'not_picked' }]);
  });

  it('maps busy, no-answer and failed', () => {
    expect(p.normalize({ ...done, Status: 'busy', RecordingUrl: undefined })[0]).toMatchObject({ event: 'ended', outcome: 'busy' });
    expect(p.normalize({ ...done, Status: 'no-answer', RecordingUrl: undefined })[0]).toMatchObject({ event: 'ended', outcome: 'not_picked' });
    expect(p.normalize({ ...done, Status: 'failed', RecordingUrl: undefined })[0]).toMatchObject({ event: 'failed', outcome: 'failed' });
  });

  it('reads the answered event', () => {
    expect(p.normalize({ ...done, EventType: 'answered' })).toMatchObject([{ event: 'answered' }]);
  });

  it('reads an inbound report with the caller as the customer', () => {
    expect(p.normalize({ ...done, Direction: 'inbound', From: '09123456789', To: '09876543210' })[0]).toMatchObject({ direction: 'incoming', customerNumber: '919123456789' });
  });

  it('ignores a recording link that is not a link, and refuses what it cannot read', () => {
    expect(p.normalize({ ...done, RecordingUrl: 'not a url' })).toHaveLength(1);
    expect(() => p.normalize({ Status: 'completed' })).toThrow(ProviderPayloadError);
    expect(() => p.normalize({ ...done, Status: 'weird' })).toThrow(ProviderPayloadError);
    expect(() => p.normalize('x')).toThrow(ProviderPayloadError);
  });
});

describe('Exotel passthru (incoming calls)', () => {
  const q = { CallSid: 'in1', CallFrom: '09123456789', CallTo: '08012345678', Direction: 'incoming', CurrentTime: '2024-01-15T10:30:00+05:30' };

  it('records a missed call when no agent answered', () => {
    for (const CallType of ['incomplete', 'client-hangup', 'voicemail', 'call-attempt']) {
      expect(p.normalize({ ...q, CallType, DialCallDuration: '0' })).toMatchObject([{ event: 'missed', direction: 'incoming', customerNumber: '919123456789' }]);
    }
  });

  it('records an answered call with its length and recording', () => {
    const events = p.normalize({ ...q, CallType: 'completed', DialCallDuration: '75', RecordingUrl: 'https://s3.amazonaws.com/r.mp3' });
    expect(events).toMatchObject([{ event: 'ended', durationSec: 75 }, { event: 'recording' }]);
    expect(events[0]!.at.toISOString()).toBe('2024-01-15T05:00:00.000Z');
  });
});

describe('Exotel settings and dialing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only Exotel hosts and an https callback address', () => {
    expect(() => p.validateConfig({ ...config, host: 'evil.example.com' })).toThrow();
    expect(() => p.validateConfig({ ...config, callbackUrl: 'http://crm.example.com/x' })).toThrow();
    expect(p.validateConfig(config)).toMatchObject({ host: 'api.exotel.com', record: true });
  });

  it('places the call with the documented fields and returns the call id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Call: { Sid: 'abc' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await p.placeCall(config, { callId: 'crm-1', agentNumber: '919876543210', customerNumber: '919123456789' });
    expect(out).toEqual({ providerCallId: 'abc' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.exotel.com/v1/Accounts/acme/Calls/connect');
    const form = init.body as URLSearchParams;
    expect(Object.fromEntries(form)).toMatchObject({ From: '+919876543210', To: '+919123456789', CallerId: '08012345678', Record: 'true', StatusCallbackContentType: 'application/json', 'StatusCallbackEvents[0]': 'terminal', 'StatusCallbackEvents[1]': 'answered' });
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('key123:token123').toString('base64')}`);
  });

  it('turns provider failures into clear errors', async () => {
    const req = { callId: 'c', agentNumber: '919876543210', customerNumber: '919123456789' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(p.placeCall(config, req)).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(p.placeCall(config, req)).rejects.toMatchObject({ code: 'PROVIDER_BUSY' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(p.placeCall(config, req)).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    await expect(p.placeCall({}, req)).rejects.toMatchObject({ code: 'TELEPHONY_NOT_CONFIGURED' });
  });
});

describe('helpers', () => {
  it('reads Exotel times and hides keys from logged addresses', () => {
    expect(exotelTime('2024-01-15 14:30:45', '+05:30')?.toISOString()).toBe('2024-01-15T09:00:45.000Z');
    expect(exotelTime('garbage', '+05:30')).toBeNull();
    expect(safeUrl('/api/v1/telephony/hooks/exotel/ahw_secretsecretsecretsecret?CallFrom=0912')).toBe('/api/v1/telephony/hooks/exotel/[redacted]');
    expect(safeUrl('/api/v1/leads?x=1')).toBe('/api/v1/leads?x=1');
  });
});
