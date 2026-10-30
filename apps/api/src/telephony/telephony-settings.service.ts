import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { SecretBox } from '../crypto/secret-box.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { ProviderRegistry } from './providers/registry.js';
import { hashWebhookKey } from './telephony-key.guard.js';

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const connectionSchema = z.object({
  provider: z.string().trim().min(2).max(40),
  isEnabled: z.boolean().default(true),
  /** The provider's own settings and credentials. Replaces what is stored; leave out to keep it. */
  config: z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 4000, 'Keep the settings under 4,000 characters').optional(),
  /** The only hosts a recording may be downloaded from, for example recordings.provider.com. */
  recordingHosts: z.array(z.string().trim().toLowerCase().regex(HOST, 'Give a host name such as recordings.example.com')).max(10).default([]),
});
export type ConnectionInput = z.infer<typeof connectionSchema>;

export interface ConnectionView {
  provider: string;
  isEnabled: boolean;
  webhookKeyPrefix: string;
  hasCredentials: boolean;
  recordingHosts: string[];
  providers: string[];
}

const newKey = () => `ahw_${randomBytes(32).toString('base64url')}`;
export const configContext = (tenantId: string) => `telephony-config:${tenantId}`;

@Injectable()
export class TelephonySettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ProviderRegistry,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext): Promise<ConnectionView | null> {
    return this.db.withTenant(auth.tenantId, (trx) => this.view(trx));
  }

  /** Creates or changes the connection. The webhook key is returned only when a new one is made. */
  save(auth: AuthContext, input: ConnectionInput): Promise<{ connection: ConnectionView; webhookKey?: string }> {
    this.registry.get(input.provider);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const existing = await this.view(trx);
      const sealed = input.config ? this.box.seal(JSON.stringify(input.config), configContext(auth.tenantId)) : null;
      let webhookKey: string | undefined;

      if (!existing) {
        webhookKey = newKey();
        await sql`
          INSERT INTO telephony_connections (tenant_id, provider, webhook_key_prefix, webhook_key_hash, config_enc, recording_hosts, is_enabled, created_by)
          VALUES (${auth.tenantId}, ${input.provider}, ${webhookKey.slice(0, 8)}, ${hashWebhookKey(webhookKey)}, ${sealed}, ${input.recordingHosts}, ${input.isEnabled}, ${auth.userId})`.execute(trx);
      } else {
        await sql`
          UPDATE telephony_connections SET provider = ${input.provider}, is_enabled = ${input.isEnabled}, recording_hosts = ${input.recordingHosts},
                 config_enc = ${sealed ?? sql`config_enc`}
          WHERE tenant_id = ${auth.tenantId}`.execute(trx);
      }
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: existing ? 'telephony.update' : 'telephony.create', entity: 'telephony_connection',
        before: existing, after: { provider: input.provider, isEnabled: input.isEnabled, recordingHosts: input.recordingHosts, credentialsChanged: !!input.config },
        ip: auth.ip, requestId: auth.requestId,
      });
      return { connection: (await this.view(trx))!, webhookKey };
    });
  }

  /** A new webhook key; the old one stops working at once. */
  rotateKey(auth: AuthContext): Promise<{ webhookKey: string; connection: ConnectionView }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      if (!(await this.view(trx))) throw AppError.notFound('Telephony connection');
      const key = newKey();
      await sql`UPDATE telephony_connections SET webhook_key_prefix = ${key.slice(0, 8)}, webhook_key_hash = ${hashWebhookKey(key)} WHERE tenant_id = ${auth.tenantId}`.execute(trx);
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'telephony.rotate_key', entity: 'telephony_connection', ip: auth.ip, requestId: auth.requestId });
      return { webhookKey: key, connection: (await this.view(trx))! };
    });
  }

  /** The stored credentials, opened. Used when placing a call or fetching a recording. */
  async credentials(trx: Trx, tenantId: string): Promise<{ provider: string; config: Record<string, unknown>; recordingHosts: string[]; isEnabled: boolean } | null> {
    const { rows } = await sql<{ provider: string; config_enc: string | null; recording_hosts: string[]; is_enabled: boolean }>`
      SELECT provider, config_enc, recording_hosts, is_enabled FROM telephony_connections WHERE tenant_id = ${tenantId}`.execute(trx);
    const r = rows[0];
    if (!r) return null;
    const config = r.config_enc ? (JSON.parse(this.box.open(r.config_enc, configContext(tenantId))) as Record<string, unknown>) : {};
    return { provider: r.provider, config, recordingHosts: r.recording_hosts, isEnabled: r.is_enabled };
  }

  private async view(trx: Trx): Promise<ConnectionView | null> {
    const { rows } = await sql<{ provider: string; is_enabled: boolean; webhook_key_prefix: string; has_credentials: boolean; recording_hosts: string[] }>`
      SELECT provider, is_enabled, webhook_key_prefix, config_enc IS NOT NULL AS has_credentials, recording_hosts FROM telephony_connections`.execute(trx);
    const r = rows[0];
    return !r ? null : { provider: r.provider, isEnabled: r.is_enabled, webhookKeyPrefix: r.webhook_key_prefix, hasCredentials: r.has_credentials, recordingHosts: r.recording_hosts, providers: this.registry.names() };
  }
}
