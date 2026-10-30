import type { CallEvent } from '../call-events.js';

export interface PlaceCallRequest {
  /** Our id for the call; the provider may hand it back in its events. */
  callId: string;
  /** The counsellor's own phone: the provider rings it first, then connects the student. */
  agentNumber: string;
  customerNumber: string;
}

/**
 * Everything the CRM needs from a telephony provider. A new provider is a new class implementing
 * this, registered in TelephonyModule; nothing else in the CRM changes.
 */
export interface TelephonyProvider {
  /** The name stored in a company's connection, for example "generic". */
  readonly name: string;
  /** Asks the provider to start a call. Returns the id the provider will use for it. */
  placeCall(config: Record<string, unknown>, request: PlaceCallRequest): Promise<{ providerCallId: string }>;
  /** Reads the provider's webhook body. Throws ProviderPayloadError when it cannot be understood. */
  normalize(body: unknown): CallEvent[];
}

export const TELEPHONY_PROVIDERS = Symbol('TELEPHONY_PROVIDERS');
