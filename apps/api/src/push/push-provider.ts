import { Logger } from '@nestjs/common';

/** One alert for one phone. */
export interface PushMessage {
  /** The phone's push token. */
  to: string;
  title: string;
  body?: string;
  data: Record<string, string>;
}

/** What happened to one alert. A "dead" token belongs to a phone that no longer takes alerts. */
export type PushResult = { status: 'ok' } | { status: 'error'; dead: boolean; message: string };

/** The whole request failed, so nothing is known about the alerts in it. `retryable` is true when trying again later may work. */
export class PushTransportError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'PushTransportError';
  }
}

/** Delivers alerts to phones. One implementation per delivery service; the rest of the app only knows this. */
export abstract class PushProvider {
  /** Returns one result per message, in the same order. Throws PushTransportError when the whole request failed. */
  abstract send(messages: readonly PushMessage[]): Promise<PushResult[]>;
}

/** Sends nothing. Used when phone alerts are switched off. */
export class NoPushProvider extends PushProvider {
  send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    return Promise.resolve(messages.map(() => ({ status: 'ok' as const })));
  }
}

const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages in one request. */
const EXPO_BATCH = 100;
/** How long a phone may be offline and still get the alert when it returns, in seconds. */
const TTL_SEC = 3600;

interface ExpoTicket { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } }

/** Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/). */
export class ExpoPushProvider extends PushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly accessToken?: string, private readonly fetchFn: typeof fetch = fetch) {
    super();
  }

  async send(messages: readonly PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH) {
      results.push(...(await this.sendBatch(messages.slice(i, i + EXPO_BATCH))));
    }
    return results;
  }

  private async sendBatch(batch: readonly PushMessage[]): Promise<PushResult[]> {
    let res: Response;
    try {
      res = await this.fetchFn(EXPO_SEND_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.accessToken && { authorization: `Bearer ${this.accessToken}` }),
        },
        body: JSON.stringify(
          batch.map((m) => ({ to: m.to, title: m.title, ...(m.body && { body: m.body }), data: m.data, sound: 'default', channelId: 'default', priority: 'high', ttl: TTL_SEC })),
        ),
      });
    } catch (e) {
      throw new PushTransportError(`Could not reach the push service: ${e instanceof Error ? e.message : String(e)}`, true);
    }

    if (!res.ok) {
      // 429 and 5xx: Expo asks callers to back off and try again. Other failures (a wrong access token) will not fix themselves.
      const body = (await res.json().catch(() => null)) as { errors?: { code?: string; message?: string }[] } | null;
      const first = body?.errors?.[0];
      throw new PushTransportError(`Push service answered ${res.status}${first ? `: ${first.code ?? ''} ${first.message ?? ''}`.trimEnd() : ''}`, res.status === 429 || res.status >= 500);
    }

    const tickets = ((await res.json()) as { data?: ExpoTicket[] }).data;
    if (!Array.isArray(tickets) || tickets.length !== batch.length) {
      throw new PushTransportError('The push service answer did not match the alerts sent', true);
    }
    return tickets.map((t): PushResult => {
      if (t.status === 'ok') return { status: 'ok' };
      const dead = t.details?.error === 'DeviceNotRegistered';
      if (!dead) this.logger.warn(`alert refused: ${t.details?.error ?? 'unknown'} ${t.message ?? ''}`.trimEnd());
      return { status: 'error', dead, message: t.message ?? t.details?.error ?? 'The alert was refused' };
    });
  }
}
