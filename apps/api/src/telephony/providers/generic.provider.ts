import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/app-error.js';
import { CallEvent, callEventSchema, ProviderPayloadError } from '../call-events.js';
import type { PlaceCallRequest, TelephonyProvider } from './provider.js';

const batchSchema = z.object({ events: z.array(callEventSchema).min(1).max(50) });

/**
 * Takes events already in the CRM's own format, and can only pretend to dial. It is what developers
 * and tests use, and what a provider can be pointed at while its real adapter is being written.
 * A company enables pretend-dialing with {"simulate": true} in its connection settings.
 */
@Injectable()
export class GenericProvider implements TelephonyProvider {
  readonly name = 'generic';

  placeCall(config: Record<string, unknown>, _request: PlaceCallRequest): Promise<{ providerCallId: string }> {
    if (config.simulate !== true) {
      throw new AppError('DIALING_NOT_AVAILABLE', 'This telephony connection can receive call events but cannot place calls yet', 501);
    }
    return Promise.resolve({ providerCallId: `sim-${randomUUID()}` });
  }

  normalize(body: unknown): CallEvent[] {
    const isBatch = typeof body === 'object' && body !== null && 'events' in body;
    const parsed = isBatch ? batchSchema.safeParse(body) : callEventSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderPayloadError(parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
    }
    return 'events' in parsed.data ? parsed.data.events : [parsed.data];
  }
}
