import pg from 'pg';
import { SecretBox } from '../src/crypto/secret-box.js';
import { ExotelProvider } from '../src/telephony/providers/exotel.provider.js';
import { connectExotelFromEnv } from '../src/telephony/env-connection.js';
import { hashWebhookKey } from '../src/telephony/telephony-key.guard.js';
import { configContext } from '../src/telephony/telephony-settings.service.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let owner: pg.Client;
let fx: Fixture;
const box = new SecretBox({ DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY! });

const ENV = {
  EXOTEL_ACCOUNT_SID: 'acme1',
  EXOTEL_API_KEY: 'key-abc',
  EXOTEL_API_TOKEN: 'token-one',
  EXOTEL_CALLER_ID: '08012345678',
  PUBLIC_API_URL: 'https://crm.example.com/api/v1',
};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
});

afterAll(async () => {
  await owner.query('DELETE FROM telephony_connections WHERE tenant_id = $1', [fx.tenantId]);
  await fx?.cleanup();
  await owner?.end();
});

const row = async () => (await owner.query(`SELECT * FROM telephony_connections WHERE tenant_id = $1`, [fx.tenantId])).rows[0];
const opened = async () => JSON.parse(box.open((await row()).config_enc, configContext(fx.tenantId))) as Record<string, unknown>;

describe('connecting Exotel from the environment', () => {
  it('stores the credentials encrypted, enabled, with a webhook key that identifies the company', async () => {
    const r = await connectExotelFromEnv(owner, box, fx.slug, ENV);
    expect(r).toMatchObject({ tenantId: fx.tenantId, created: true, keptKey: false });

    const stored = await row();
    expect(stored).toMatchObject({ provider: 'exotel', is_enabled: true });
    // Nothing readable in the database.
    expect(stored.config_enc).not.toContain('token-one');
    expect(stored.config_enc).not.toContain('key-abc');
    // The stored settings are what the Exotel adapter accepts.
    expect(new ExotelProvider().validateConfig(await opened())).toMatchObject({ accountSid: 'acme1', apiToken: 'token-one', callerId: '08012345678' });
    // The key in the address is the one the API will accept for this company.
    expect(stored.webhook_key_hash).toBe(hashWebhookKey(r.webhookKey));
    expect(r.callbackUrl.endsWith(r.webhookKey)).toBe(true);
    const found = await owner.query(`SELECT tenant_id FROM resolve_telephony_key($1)`, [hashWebhookKey(r.webhookKey)]);
    expect(found.rows[0].tenant_id).toBe(fx.tenantId);
  });

  it('on a second run keeps the key already given to Exotel and replaces the credentials', async () => {
    const before = await row();
    const r = await connectExotelFromEnv(owner, box, fx.slug, { ...ENV, EXOTEL_API_TOKEN: 'token-two', EXOTEL_RECORDING_HOSTS: 'recordings.example.com' });
    expect(r).toMatchObject({ created: false, keptKey: true });
    const after = await row();
    expect(after.webhook_key_hash).toBe(before.webhook_key_hash);
    expect(after.recording_hosts).toEqual(['recordings.example.com']);
    expect((await opened()).apiToken).toBe('token-two');
  });

  it('writes an audit entry that holds no credentials', async () => {
    const { rows } = await owner.query(`SELECT after FROM audit_logs WHERE tenant_id = $1 AND action = 'telephony.configure_from_env'`, [fx.tenantId]);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toMatch(/token-|key-abc|ahw_/);
  });

  it('changes nothing when a setting is wrong or the company does not exist', async () => {
    const before = await row();
    await expect(connectExotelFromEnv(owner, box, fx.slug, { ...ENV, EXOTEL_API_KEY: '' })).rejects.toThrow(/EXOTEL_API_KEY is missing/);
    await expect(connectExotelFromEnv(owner, box, 'no-such-company', ENV)).rejects.toThrow(/no company/);
    expect((await row()).config_enc).toBe(before.config_enc);
    // The connection is still usable: the failed run left no open transaction behind.
    expect((await owner.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });
});
