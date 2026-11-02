import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { CircuitBreaker } from '../../common/circuit-breaker.js';
import { normalizePhone } from '../../common/phone.js';
import { CallEvent, ProviderPayloadError } from '../call-events.js';
import type { PlaceCallRequest, TelephonyProvider } from './provider.js';

/**
 * Exotel (https://developer.exotel.com). Field names below are the ones Exotel documents:
 *  - placing a call: POST /v1/Accounts/{sid}/Calls/connect (Basic auth, form body), answer {"Call":{"Sid":...}};
 *  - after a call we ask for a JSON StatusCallback (StatusCallbackEvents terminal + answered);
 *  - incoming calls reach us from a Passthru applet (GET, parameters in the query string).
 * Exotel does not sign its callbacks and cannot send custom headers, so the company's webhook key
 * travels in the callback address (/telephony/hooks/exotel/<key>), which is kept out of the logs.
 */

/** Only Exotel's own API hosts are ever called, so a bad setting cannot point the server elsewhere. */
export const EXOTEL_HOSTS = ['api.exotel.com', 'api.in.exotel.com'] as const;

export const exotelConfigSchema = z.object({
  accountSid: z.string().trim().regex(/^[A-Za-z0-9_-]{2,60}$/),
  apiKey: z.string().trim().min(4).max(120),
  apiToken: z.string().trim().min(4).max(200),
  /** The ExoPhone the student sees and calls back on. */
  callerId: z.string().trim().min(5).max(20),
  host: z.enum(EXOTEL_HOSTS).default('api.exotel.com'),
  /** The full callback address, https://<api>/api/v1/telephony/hooks/exotel/<webhook key>. */
  callbackUrl: z.url().max(500).refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(u), 'Use an https address'),
  record: z.boolean().default(true),
});
export type ExotelConfig = z.infer<typeof exotelConfigSchema>;

const text = z.union([z.string(), z.number()]).transform(String);
const statusCallbackSchema = z.object({
  CallSid: text,
  Status: z.string().optional(),
  EventType: z.string().optional(),
  DateUpdated: z.string().optional(),
  StartTime: z.string().nullish(),
  EndTime: z.string().nullish(),
  From: text.optional(),
  To: text.optional(),
  Direction: z.string().optional(),
  ConversationDuration: z.union([z.string(), z.number()]).nullish(),
  RecordingUrl: z.string().nullish(),
});

const passthruSchema = z.object({
  CallSid: text,
  CallFrom: text,
  CallTo: text.optional(),
  Direction: z.string().optional(),
  CallType: z.string().optional(),
  DialCallStatus: z.string().optional(),
  DialCallDuration: z.union([z.string(), z.number()]).nullish(),
  DialWhomNumber: text.optional(),
  RecordingUrl: z.string().nullish(),
  CurrentTime: z.string().optional(),
  Created: z.string().optional(),
});

function seconds(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 86_400 ? n : undefined;
}

/** "2024-01-15 14:30:45" in the company's offset, or an ISO stamp that already carries one. */
export function exotelTime(value: string | null | undefined, offset: string): Date | null {
  if (!value) return null;
  const v = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : `${v.replace(' ', 'T')}${offset}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function phone(value: string | undefined): string | undefined {
  return value ? (normalizePhone(value) ?? undefined) : undefined;
}

function recording(value: string | null | undefined): string | undefined {
  return value && z.url().safeParse(value).success ? value : undefined;
}

@Injectable()
export class ExotelProvider implements TelephonyProvider {
  readonly name = 'exotel';

  /** Exotel does not say which time zone its "YYYY-MM-DD HH:mm:ss" stamps use; India's is assumed (to be checked on the first real call). */
  private readonly utcOffset = '+05:30';

  /**
   * One breaker per Exotel address. After a few failures in a row (no answer, a timeout, a 5xx) calls
   * are refused at once for a short while instead of each one waiting for its timeout. An answer such as
   * 401 or 429 means Exotel is up, so it does not count as a failure.
   */
  private readonly breakers = new Map<string, CircuitBreaker>();

  private breakerFor(host: string): CircuitBreaker {
    let breaker = this.breakers.get(host);
    if (!breaker) {
      breaker = new CircuitBreaker(5, 30_000);
      this.breakers.set(host, breaker);
    }
    return breaker;
  }

  validateConfig(config: Record<string, unknown>): Record<string, unknown> {
    const parsed = exotelConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new AppError('CONFIG_INVALID', 'The Exotel settings are not complete', 422, parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? 'config'), message: i.message })));
    }
    return parsed.data;
  }

  async placeCall(rawConfig: Record<string, unknown>, request: PlaceCallRequest): Promise<{ providerCallId: string }> {
    const parsed = exotelConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new AppError('TELEPHONY_NOT_CONFIGURED', 'The Exotel connection is missing details. Ask an admin to complete it in Settings → Telephony.', 422);
    }
    const c = parsed.data;
    const body = new URLSearchParams({
      From: `+${request.agentNumber}`,
      To: `+${request.customerNumber}`,
      CallerId: c.callerId,
      Record: String(c.record),
      CustomField: request.callId.slice(0, 128),
      StatusCallback: c.callbackUrl,
      StatusCallbackContentType: 'application/json',
    });
    body.append('StatusCallbackEvents[0]', 'terminal');
    body.append('StatusCallbackEvents[1]', 'answered');

    const breaker = this.breakerFor(c.host);
    if (!breaker.tryAcquire()) {
      throw new AppError('PROVIDER_PAUSED', 'Calling is paused for a moment because the calling service is not answering. Try again in a minute.', 503, undefined, { 'retry-after': String(Math.max(1, breaker.retryAfterSec)) });
    }

    let res: Response;
    try {
      res = await fetch(`https://${c.host}/v1/Accounts/${encodeURIComponent(c.accountSid)}/Calls/connect`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      breaker.failure();
      throw new AppError('PROVIDER_UNREACHABLE', 'The calling service did not answer. Try again in a moment.', 502);
    }
    if (res.status >= 500) breaker.failure();
    else breaker.success();
    if (res.status === 401 || res.status === 403) throw new AppError('PROVIDER_AUTH', 'Exotel rejected the saved login details. Ask an admin to check them.', 502);
    if (res.status === 429) throw new AppError('PROVIDER_BUSY', 'Too many calls are being placed at once. Try again in a few seconds.', 429);
    if (!res.ok) throw new AppError('PROVIDER_ERROR', 'The calling service did not accept the call. Try again in a moment.', 502);

    const json = (await res.json().catch(() => null)) as { Call?: { Sid?: unknown } } | null;
    const sid = json?.Call?.Sid;
    if (typeof sid !== 'string' || sid.length === 0) throw new AppError('PROVIDER_ERROR', 'The calling service gave an answer we could not read.', 502);
    return { providerCallId: sid };
  }

  normalize(body: unknown): CallEvent[] {
    if (typeof body !== 'object' || body === null) throw new ProviderPayloadError('Expected an Exotel call report');
    // Passthru reports carry CallFrom; StatusCallback reports do not.
    return 'CallFrom' in body ? this.fromPassthru(body) : this.fromStatusCallback(body);
  }

  private fromStatusCallback(body: object): CallEvent[] {
    const p = statusCallbackSchema.safeParse(body);
    if (!p.success) throw new ProviderPayloadError(`Exotel report not understood: ${p.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const r = p.data;
    const incoming = r.Direction === 'inbound';
    const customerNumber = phone(incoming ? r.From : r.To);
    if (!customerNumber) throw new ProviderPayloadError('Exotel report has no usable customer number');
    const agentNumber = phone(incoming ? r.To : r.From);
    const base = { providerCallId: r.CallSid, direction: incoming ? ('incoming' as const) : ('outgoing' as const), customerNumber, agentNumber };

    if (r.EventType === 'answered') {
      const at = exotelTime(r.StartTime ?? r.DateUpdated, this.utcOffset) ?? new Date();
      return [{ ...base, event: 'answered', at }];
    }

    const at = exotelTime(r.EndTime ?? r.DateUpdated, this.utcOffset) ?? new Date();
    const talk = seconds(r.ConversationDuration) ?? 0;
    const events: CallEvent[] = [];
    switch (r.Status) {
      case 'completed':
        // Both legs were joined only if they actually talked.
        events.push(talk > 0 ? { ...base, event: 'ended', at, durationSec: talk } : { ...base, event: 'ended', at, durationSec: 0, outcome: 'not_picked' });
        break;
      case 'busy':
        events.push({ ...base, event: 'ended', at, durationSec: 0, outcome: 'busy' });
        break;
      case 'no-answer':
        events.push({ ...base, event: 'ended', at, durationSec: 0, outcome: 'not_picked' });
        break;
      case 'failed':
        events.push({ ...base, event: 'failed', at, outcome: 'failed' });
        break;
      default:
        throw new ProviderPayloadError(`Exotel status "${r.Status ?? ''}" is not one we act on`);
    }
    const url = recording(r.RecordingUrl);
    if (url) events.push({ ...base, event: 'recording', at, recordingUrl: url });
    return events;
  }

  private fromPassthru(body: object): CallEvent[] {
    const p = passthruSchema.safeParse(body);
    if (!p.success) throw new ProviderPayloadError(`Exotel report not understood: ${p.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const r = p.data;
    const customerNumber = phone(r.CallFrom);
    if (!customerNumber) throw new ProviderPayloadError('Exotel report has no usable caller number');
    const at = exotelTime(r.CurrentTime, this.utcOffset) ?? exotelTime(r.Created, this.utcOffset) ?? new Date();
    const base = { providerCallId: r.CallSid, direction: 'incoming' as const, customerNumber, agentNumber: phone(r.DialWhomNumber) };

    // Exotel's CallType: completed = they talked; incomplete / client-hangup / voicemail / call-attempt = nobody took it.
    const talked = r.CallType === 'completed' || r.DialCallStatus === 'completed';
    const events: CallEvent[] = [];
    if (talked) {
      events.push({ ...base, event: 'ended', at, durationSec: seconds(r.DialCallDuration) ?? 0 });
      const url = recording(r.RecordingUrl);
      if (url) events.push({ ...base, event: 'recording', at, recordingUrl: url });
    } else {
      events.push({ ...base, event: 'missed', at });
    }
    return events;
  }
}
