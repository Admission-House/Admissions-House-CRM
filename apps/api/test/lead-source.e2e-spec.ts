import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart } from './helpers/multipart.js';

/** Where a lead came from is for the Admin and Super Admin; the counsellor who works the lead does not see it. */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const phone = '9' + String(800_000_000 + Math.floor(Math.random() * 99_999)).padStart(9, '0');
let leadId = '';

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  // A sheet imported by the admin, the lead given to the counsellor.
  const body = multipart(
    { sourceId: fx.sourceId('Meta Ads'), assign: 'user', userId: fx.user('lc1').id },
    [
      {
        filename: 'campaign leads.csv',
        data: Buffer.from(`Name,Phone,Course\nSource Probe,${phone},MBA\n`, 'utf8'),
      },
    ],
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/leads/import',
    payload: body.payload,
    headers: { authorization: `Bearer ${t.admin}`, 'content-type': body.contentType },
  });
  expect(res.statusCode, res.body).toBe(202);
  leadId = (
    await owner.query(`SELECT id FROM leads WHERE tenant_id = $1 AND primary_phone = $2`, [
      fx.tenantId,
      `91${phone}`,
    ])
  ).rows[0].id;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('who sees where a lead came from', () => {
  it('shows it to the Admin and the Super Admin', async () => {
    for (const who of ['admin', 'sa']) {
      const list = (
        await api.call(
          'GET',
          '/leads?q=Source%20Probe',
          t[who]!,
          undefined,
          who === 'admin' ? '10.20.0.5' : undefined,
        )
      ).json().items[0];
      expect(list.source, who).toMatchObject({ name: 'Meta Ads' });
      const detail = (
        await api.call(
          'GET',
          `/leads/${leadId}`,
          t[who]!,
          undefined,
          who === 'admin' ? '10.20.0.5' : undefined,
        )
      ).json();
      expect(detail.source, who).toMatchObject({ name: 'Meta Ads' });
      expect(detail.enquiries[0].source, who).toBe('Meta Ads');
      const history = (
        await api.call(
          'GET',
          `/leads/${leadId}/activities`,
          t[who]!,
          undefined,
          who === 'admin' ? '10.20.0.5' : undefined,
        )
      )
        .json()
        .items.map((a: { remark: string | null }) => a.remark);
      expect(history.join(' | '), who).toContain('New lead from Meta Ads');
    }
  });

  it('keeps it from the counsellor: not in the list, the lead, the history, the filter, the reports or the notices', async () => {
    const ip = '10.20.0.5';
    const list = (await api.call('GET', '/leads?q=Source%20Probe', t.lc1!, undefined, ip)).json()
      .items;
    expect(list).toHaveLength(1);
    expect(list[0].source).toBeNull();

    const detail = (await api.call('GET', `/leads/${leadId}`, t.lc1!, undefined, ip)).json();
    expect(detail.source).toBeNull();
    expect(detail.enquiries).toHaveLength(1);
    expect(detail.enquiries[0]).toMatchObject({ source: null, formName: null, page: null });
    expect(JSON.stringify(detail)).not.toContain('Meta Ads');

    const history = (await api.call('GET', `/leads/${leadId}/activities`, t.lc1!, undefined, ip))
      .json()
      .items.map((a: { remark: string | null }) => a.remark ?? '');
    expect(history.join(' | ')).toContain('New lead');
    expect(history.join(' | ')).not.toContain('Meta Ads');
    expect(history.join(' | ')).not.toContain('campaign leads');

    // Asking for one source cannot be used to find out which leads came from it.
    const filtered = (
      await api.call(
        'GET',
        `/leads?q=Source%20Probe&sourceId=${fx.sourceId('Website')}`,
        t.lc1!,
        undefined,
        ip,
      )
    ).json().items;
    expect(filtered).toHaveLength(1);

    expect(
      (await api.call('GET', '/reports/leads?groupBy=source', t.lc1!, undefined, ip)).statusCode,
    ).toBe(403);
    expect(
      (await api.call('GET', '/reports/tat?groupBy=source', t.lc1!, undefined, ip)).statusCode,
    ).toBe(403);
    expect(
      (await api.call('GET', '/reports/leads?groupBy=status', t.lc1!, undefined, ip)).statusCode,
    ).toBe(200);

    const notices = (await api.call('GET', '/notifications', t.lc1!, undefined, ip)).json()
      .items as { payload: Record<string, unknown> }[];
    for (const n of notices) expect(n.payload).not.toHaveProperty('source');
  });

  it('leaves the source out of a notice for the counsellor, and in it for the Admin', async () => {
    for (const who of ['lc1', 'admin']) {
      await owner.query(
        `INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1, $2, 'assignment', $3::jsonb)`,
        [
          fx.tenantId,
          fx.user(who).id,
          JSON.stringify({ event: 'lead_assigned', name: 'Source Probe', source: 'Meta Ads' }),
        ],
      );
    }
    const mine = (await api.call('GET', '/notifications', t.lc1!, undefined, '10.20.0.5')).json()
      .items as { payload: Record<string, unknown> }[];
    const theirs = (
      await api.call('GET', '/notifications', t.admin!, undefined, '10.20.0.5')
    ).json().items as { payload: Record<string, unknown> }[];
    expect(mine.find((n) => n.payload?.event === 'lead_assigned')?.payload).toEqual({
      event: 'lead_assigned',
      name: 'Source Probe',
    });
    expect(theirs.find((n) => n.payload?.event === 'lead_assigned')?.payload).toMatchObject({
      source: 'Meta Ads',
    });
  });
});
