import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizePhone } from '../common/phone.js';

/**
 * What the CRM understands about a call, whatever the provider calls things. Each provider adapter
 * turns its own webhook into these events; everything after that is provider-independent.
 */
export const CALL_EVENTS = ['ringing', 'answered', 'ended', 'missed', 'failed', 'recording'] as const;

const phoneText = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid phone number' });
      return z.NEVER;
    }
    return n;
  });

export const callEventSchema = z.object({
  providerCallId: z.string().trim().min(1).max(120),
  event: z.enum(CALL_EVENTS),
  direction: z.enum(['incoming', 'outgoing']),
  /** The student's number. */
  customerNumber: phoneText,
  /** The counsellor's own number, when the provider says which one took or placed the call. */
  agentNumber: phoneText.optional(),
  at: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  durationSec: z.number().int().min(0).max(86_400).optional(),
  /** For an ended call that was never answered: why. */
  outcome: z.enum(['not_picked', 'busy', 'failed']).optional(),
  recordingUrl: z.url().max(2000).optional(),
});
export type CallEvent = z.infer<typeof callEventSchema>;

export class ProviderPayloadError extends Error {}

/** The same event delivered twice has the same key, so the second delivery is recognised. */
export function eventKey(e: CallEvent): string {
  return createHash('sha256').update(`${e.providerCallId}|${e.event}|${e.at.toISOString()}`).digest('hex').slice(0, 40);
}
