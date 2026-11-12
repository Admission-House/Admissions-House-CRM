import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secret-box.js';
import { EXOTEL_HOSTS, exotelConfigSchema } from './providers/exotel.provider.js';
import { hashWebhookKey } from './telephony-key.guard.js';
import { configContext, HOST } from './telephony-settings.service.js';

/**
 * Sets up a company's Exotel connection from environment settings, so the credentials live in the
 * deployment's .env and not in anybody's chat or browser. The result is stored exactly as the
 * Settings > Telephony page stores it (encrypted, tied to the company), so everything that places
 * calls or receives Exotel's callbacks works unchanged.
 *
 * The settings are read only when this is run (`pnpm telephony:connect <company>`); the running API
 * never reads them.
 */
export const exotelEnvSchema = z.object({
  EXOTEL_ACCOUNT_SID: z.string({ error: 'is missing' }).trim().min(1, 'is missing'),
  EXOTEL_API_KEY: z.string({ error: 'is missing' }).trim().min(1, 'is missing'),
  EXOTEL_API_TOKEN: z.string({ error: 'is missing' }).trim().min(1, 'is missing'),
  /** The ExoPhone (virtual number) the student sees. */
  EXOTEL_CALLER_ID: z.string({ error: 'is missing' }).trim().min(1, 'is missing'),
  EXOTEL_HOST: z.enum(EXOTEL_HOSTS).default('api.exotel.com'),
  EXOTEL_RECORD: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Hosts a recording may be downloaded from, separated by commas or spaces. Empty = recordings are not fetched. */
  EXOTEL_RECORDING_HOSTS: z
    .string()
    .default('')
    .transform((v) => v.split(/[\s,]+/).map((h) => h.toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(HOST, 'must be host names such as recordings.example.com')).max(10)),
  /** Where Exotel reaches this API from the internet, up to and including /api/v1. */
  PUBLIC_API_URL: z.url({ error: 'must be a full web address such as https://crm.example.com/api/v1' }).transform((u) => u.replace(/\/+$/, '')),
});

const WEBHOOK_KEY = /^ahw_[A-Za-z0-9_-]{20,80}$/;
const newKey = () => `ahw_${randomBytes(32).toString('base64url')}`;

export interface ExotelConnection {
  config: z.infer<typeof exotelConfigSchema>;
  recordingHosts: string[];
  webhookKey: string;
  callbackUrl: string;
}

/** Turns the environment into the stored settings. Names the settings that are wrong, never shows their values. */
export function buildExotelConnection(env: Record<string, string | undefined>, existingKey?: string): ExotelConnection {
  const parsed = exotelEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`).join('; '));
  }
  const e = parsed.data;
  const webhookKey = existingKey && WEBHOOK_KEY.test(existingKey) ? existingKey : newKey();
  const callbackUrl = `${e.PUBLIC_API_URL}/telephony/hooks/exotel/${webhookKey}`;
  const config = exotelConfigSchema.safeParse({
    accountSid: e.EXOTEL_ACCOUNT_SID, apiKey: e.EXOTEL_API_KEY, apiToken: e.EXOTEL_API_TOKEN,
    callerId: e.EXOTEL_CALLER_ID, host: e.EXOTEL_HOST, callbackUrl, record: e.EXOTEL_RECORD,
  });
  if (!config.success) {
    // Which settings are wrong, by their environment names; their values are never printed.
    const names: Record<string, string> = { accountSid: 'EXOTEL_ACCOUNT_SID', apiKey: 'EXOTEL_API_KEY', apiToken: 'EXOTEL_API_TOKEN', callerId: 'EXOTEL_CALLER_ID', host: 'EXOTEL_HOST', callbackUrl: 'PUBLIC_API_URL' };
    throw new Error(config.error.issues.map((i) => `${names[String(i.path[0])] ?? String(i.path[0])} is not valid`).join('; '));
  }
  return { config: config.data, recordingHosts: e.EXOTEL_RECORDING_HOSTS, webhookKey, callbackUrl };
}

export interface ConnectResult {
  tenantId: string;
  created: boolean;
  /** True when the webhook key was kept, so the address already given to Exotel still works. */
  keptKey: boolean;
  callbackUrl: string;
  webhookKey: string;
}

/**
 * Creates or updates the company's connection. Run with the owner's database connection (the same one
 * the migrations use). Everything happens in one transaction.
 */
export async function connectExotelFromEnv(db: pg.Client, box: SecretBox, slug: string, env: Record<string, string | undefined>): Promise<ConnectResult> {
  await db.query('BEGIN');
  try {
    const tenant = (await db.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug])).rows[0];
    if (!tenant) throw new Error(`there is no company with the short name "${slug}"`);
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

    // The key already given to Exotel lives inside the stored callback address; keep it when it can be read.
    const existing = (await db.query<{ config_enc: string | null }>('SELECT config_enc FROM telephony_connections WHERE tenant_id = $1', [tenant.id])).rows[0];
    let keptKeyFrom: string | undefined;
    if (existing?.config_enc) {
      try {
        const old = JSON.parse(box.open(existing.config_enc, configContext(tenant.id))) as { callbackUrl?: string };
        keptKeyFrom = old.callbackUrl?.split('/').pop();
      } catch {
        keptKeyFrom = undefined;
      }
    }

    const built = buildExotelConnection(env, keptKeyFrom);
    const sealed = box.seal(JSON.stringify(built.config), configContext(tenant.id));
    await db.query(
      `INSERT INTO telephony_connections (tenant_id, provider, webhook_key_prefix, webhook_key_hash, config_enc, recording_hosts, is_enabled)
       VALUES ($1, 'exotel', $2, $3, $4, $5, true)
       ON CONFLICT (tenant_id) DO UPDATE SET provider = 'exotel', webhook_key_prefix = EXCLUDED.webhook_key_prefix,
         webhook_key_hash = EXCLUDED.webhook_key_hash, config_enc = EXCLUDED.config_enc,
         recording_hosts = EXCLUDED.recording_hosts, is_enabled = true`,
      [tenant.id, built.webhookKey.slice(0, 8), hashWebhookKey(built.webhookKey), sealed, built.recordingHosts],
    );
    await db.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, entity, after) VALUES ($1, NULL, 'telephony.configure_from_env', 'telephony_connection', $2)`,
      [tenant.id, JSON.stringify({ provider: 'exotel', host: built.config.host, record: built.config.record, recordingHosts: built.recordingHosts, keptKey: built.webhookKey === keptKeyFrom })],
    );
    await db.query('COMMIT');
    return { tenantId: tenant.id, created: !existing, keptKey: built.webhookKey === keptKeyFrom, callbackUrl: built.callbackUrl, webhookKey: built.webhookKey };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
