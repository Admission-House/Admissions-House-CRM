import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { makeClient, Client } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

/**
 * The office check with the real set-up of the Greater Noida office: one fixed address kept from before, and the
 * 103.77.1.x block the office line really uses (its address changes from day to day inside that block).
 */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;

const OFFICE_SPOT = { lat: 28.600811, lng: 77.432513 };
const here = { ...OFFICE_SPOT, accuracy: 25 };

const signIn = (who: string, ip: string, location?: Record<string, unknown>) =>
  api.login({ ...api.credentials(who), ...(location && { location }) }, ip);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  const branch = (await owner.query(`SELECT id FROM branches WHERE tenant_id = $1 LIMIT 1`, [fx.tenantId])).rows[0].id as string;
  await owner.query(`DELETE FROM branch_networks WHERE tenant_id = $1`, [fx.tenantId]);
  for (const range of ['119.252.207.205/32', '103.77.1.0/24']) {
    await owner.query(`INSERT INTO branch_networks (tenant_id, branch_id, kind, ip_range) VALUES ($1, $2, 'ip_range', $3::cidr)`, [fx.tenantId, branch, range]);
  }
  await owner.query(`UPDATE branches SET latitude = $2, longitude = $3, radius_m = 150 WHERE id = $1`, [branch, OFFICE_SPOT.lat, OFFICE_SPOT.lng]);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('counsellors and admins signing in from the office', () => {
  it.each(['counsellor', 'admin'])('lets a %s in from any address in the office block, on a different day too', async (who) => {
    for (const ip of ['103.77.1.254', '103.77.1.65', '103.77.1.1', '119.252.207.205']) {
      const res = await signIn(who, ip, here);
      expect(res.statusCode, `${who} from ${ip}: ${res.body}`).toBe(200);
    }
  });

  it('refuses an address outside the block, and says it is the network', async () => {
    for (const ip of ['103.77.2.10', '103.77.0.255', '117.99.227.76']) {
      const res = await signIn('counsellor', ip, here);
      expect(res.statusCode, ip).toBe(403);
      expect(res.json().error.code).toBe('OUTSIDE_OFFICE');
      expect(res.json().error.details?.reason).toBe('network');
    }
  });

  it('still needs the place: no position, a position far away, a vague one, or a faked one is refused', async () => {
    const ip = '103.77.1.65';
    expect((await signIn('counsellor', ip)).json().error.details?.reason).toBe('gps_missing');
    expect((await signIn('counsellor', ip, { lat: 28.62, lng: 77.45, accuracy: 20 })).json().error.details?.reason).toBe('gps_far');
    expect((await signIn('counsellor', ip, { ...here, accuracy: 900 })).json().error.details?.reason).toBe('gps_inaccurate');
    expect((await signIn('counsellor', ip, { ...here, mocked: true })).json().error.details?.reason).toBe('gps_mocked');
  });

  it('lets a Super Admin in from anywhere, as the company intends', async () => {
    const res = await signIn('super', '117.99.227.76');
    expect(res.statusCode, res.body).toBe(200);
  });
});
