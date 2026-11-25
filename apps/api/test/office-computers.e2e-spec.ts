import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, inOffice, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP, OUTSIDE_IP } from './helpers/fixtures.js';

/**
 * Office sign-in with registered computers. The address the internet provider gives changes from day to day, so a computer that
 * has proved it belongs to the office is recognised again without the address; the person's position is always still checked.
 */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let boss: string;
const NEW_ADDRESS = '198.51.100.77'; // an address that is not on the office list (the one the provider gave today)

const token = () => randomBytes(32).toString('base64url');

/** One sign-in from a browser that holds `cookie` (if any), the way the web app does it. */
const signIn = (
  who: string,
  o: {
    ip?: string;
    cookie?: string;
    location?: Record<string, unknown> | null;
    clientType?: 'web' | 'mobile';
  } = {},
) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: o.ip ?? NEW_ADDRESS,
    headers: o.cookie ? { cookie: `ah_oc=${o.cookie}` } : {},
    payload: {
      ...api.credentials(who),
      ...(o.location === null ? {} : { location: o.location ?? inOffice }),
      ...(o.clientType && { clientType: o.clientType }),
    },
  });
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'ah_oc')?.value;
const reason = (res: { json: () => { error?: { details?: { reason?: string } } } }) =>
  res.json().error?.details?.reason;
const userId = async (who: string) => fx.user(who).id;
const rows = async (who: string, state?: string) =>
  (
    await owner.query(
      `SELECT id, state, registered_by FROM office_computers WHERE user_id = $1 ${state ? `AND state = '${state}'` : ''} ORDER BY created_at`,
      [await userId(who)],
    )
  ).rows as { id: string; state: string; registered_by: string | null }[];
const notices = async (event: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*) FROM notifications WHERE tenant_id = $1 AND type = 'security' AND payload->>'event' = $2`,
        [fx.tenantId, event],
      )
    ).rows[0].count,
  );

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  boss = await api.signIn('super');
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

describe('a computer that signs in from an office address', () => {
  it('is registered at once, is given its own cookie, and is recognised from any address afterwards', async () => {
    const first = await signIn('att1', { ip: OFFICE_IP });
    expect(first.statusCode, first.body).toBe(200);
    const mine = cookieOf(first);
    expect(mine).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = first.cookies.find((c) => c.name === 'ah_oc')!;
    expect(set).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });
    expect(await rows('att1', 'approved')).toHaveLength(1);
    expect((await rows('att1'))[0]!.registered_by).toBe('office_network');

    // Another day, another address from the provider: the same computer, at the office, signs in.
    const next = await signIn('att1', { ip: NEW_ADDRESS, cookie: mine });
    expect(next.statusCode, next.body).toBe(200);
    expect(cookieOf(next)).toBeUndefined(); // it already has its cookie
  });

  it('keeps the cookie it already holds, and stores only a hash of it', async () => {
    const held = token();
    const res = await signIn('att2', { ip: OFFICE_IP, cookie: held });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)).toBeUndefined();
    const stored = (
      await owner.query(`SELECT token_hash FROM office_computers WHERE user_id = $1`, [
        await userId('att2'),
      ])
    ).rows[0].token_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(held);
  });
});

describe('a computer the office has not seen before, on an address that is not on the list', () => {
  it('asks the Super Admin to approve it, turns the person away for now, and does not ask twice', async () => {
    const before = await notices('computer_request');
    const first = await signIn('att3');
    expect(first.statusCode).toBe(403);
    expect(first.json().error.code).toBe('OUTSIDE_OFFICE');
    expect(reason(first)).toBe('computer');
    expect(first.json().error.message).toContain('not registered');
    const mine = cookieOf(first)!;
    expect(mine).toBeDefined();
    expect(await rows('att3', 'pending')).toHaveLength(1);
    expect(await notices('computer_request')).toBeGreaterThan(before);

    const again = await signIn('att3', { cookie: mine });
    expect(reason(again)).toBe('computer');
    expect(await rows('att3')).toHaveLength(1); // the same request, not a second one
  });

  it('lets that computer in once a Super Admin approves it, from the address it signs in from', async () => {
    const first = await signIn('att4');
    const mine = cookieOf(first)!;
    const [pending] = await rows('att4', 'pending');
    const list = (await api.call('GET', '/office-computers?state=pending', boss)).json() as {
      id: string;
      user: { name: string };
      label: string | null;
    }[];
    expect(list.find((c) => c.id === pending!.id)).toBeDefined();
    const approved = await api.call('POST', `/office-computers/${pending!.id}/approve`, boss);
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await rows('att4'))[0]).toMatchObject({ state: 'approved', registered_by: 'approval' });
    const ok = await signIn('att4', { cookie: mine });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'office_computer.approve'`,
          [fx.tenantId],
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
  });

  it('stays turned away when a person rejects it, and is not asked about again', async () => {
    const first = await signIn('att5');
    const mine = cookieOf(first)!;
    const [pending] = await rows('att5', 'pending');
    expect(
      (await api.call('POST', `/office-computers/${pending!.id}/reject`, boss)).statusCode,
    ).toBe(200);
    const again = await signIn('att5', { cookie: mine });
    expect(again.statusCode).toBe(403);
    expect(reason(again)).toBe('network');
    expect(await rows('att5', 'pending')).toHaveLength(0);
  });

  it('says nothing new, and records no request, when the position is wrong or missing: it is not the office', async () => {
    for (const location of [
      null,
      { lat: 28.7, lng: 77.5, accuracy: 20 },
      { ...inOffice, accuracy: 900 },
    ]) {
      const res = await signIn('att6', { location });
      expect(res.statusCode).toBe(403);
      expect(reason(res)).toBe('network');
    }
    expect(await rows('att6')).toHaveLength(0);
  });
});

describe('the position is always checked', () => {
  it('turns away a registered computer that is not at the office', async () => {
    const first = await signIn('att7', { ip: OFFICE_IP });
    const mine = cookieOf(first)!;
    const far = await signIn('att7', {
      cookie: mine,
      location: { lat: 28.7, lng: 77.5, accuracy: 20 },
    });
    expect(far.statusCode).toBe(403);
    expect(reason(far)).toBe('gps_far');
    const none = await signIn('att7', { cookie: mine, location: null });
    expect(reason(none)).toBe('gps_missing');
    const mocked = await signIn('att7', { cookie: mine, location: { ...inOffice, mocked: true } });
    expect(reason(mocked)).toBe('gps_mocked');
  });
});

describe('who a registration belongs to', () => {
  it('does not carry over to another person on the same computer', async () => {
    const a = await signIn('att8', { ip: OFFICE_IP });
    const mine = cookieOf(a)!;
    const b = await signIn('att9', { cookie: mine });
    expect(b.statusCode).toBe(403);
    expect(reason(b)).toBe('computer');
    // and two people may each have the shared computer registered on their own
    const c = await signIn('att9', { ip: OFFICE_IP, cookie: mine });
    expect(c.statusCode).toBe(200);
    expect(await rows('att9', 'approved')).toHaveLength(1);
    expect(await rows('att8', 'approved')).toHaveLength(1);
  });

  it('is gone when a person removes the computer', async () => {
    const a = await signIn('att10', { ip: OFFICE_IP });
    const mine = cookieOf(a)!;
    expect((await signIn('att10', { cookie: mine })).statusCode).toBe(200);
    const [row] = await rows('att10', 'approved');
    const removed = await api.call('DELETE', `/office-computers/${row!.id}`, boss);
    expect(removed.statusCode, removed.body).toBe(200);
    const after = await signIn('att10', { cookie: mine });
    expect(after.statusCode).toBe(403);
    expect(reason(after)).toBe('computer'); // asks again, as for any computer the office has not seen
  });

  it('keeps only the five computers used most recently', async () => {
    for (let i = 0; i < 7; i++)
      expect((await signIn('att11', { ip: OFFICE_IP, cookie: token() })).statusCode).toBe(200);
    expect(await rows('att11', 'approved')).toHaveLength(5);
  });
});

describe('who may approve', () => {
  it('is refused to a counsellor, and a person cannot approve their own computer', async () => {
    const lc = await api.signIn('lc1', { office: true });
    expect((await api.call('GET', '/office-computers', lc)).statusCode).toBe(403);
    const first = await signIn('lc2');
    expect(first.statusCode).toBe(403);
    const [pending] = await rows('lc2', 'pending');
    expect(
      (await api.call('POST', `/office-computers/${pending!.id}/approve`, lc)).statusCode,
    ).toBe(403);

    // An Admin may approve, but not their own computer.
    const admin = await api.signIn('admin', { office: true });
    const adminFirst = await signIn('admin');
    expect(reason(adminFirst)).toBe('computer');
    const [own] = await rows('admin', 'pending');
    const self = await api.call('POST', `/office-computers/${own!.id}/approve`, admin);
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_APPROVAL');
    expect(
      (await api.call('POST', `/office-computers/${pending!.id}/approve`, admin)).statusCode,
    ).toBe(200);
  });
});

describe('the sign-in itself stays safe', () => {
  it('works for everyone at once: seven counsellors and three Super Admins signing in together', async () => {
    const counsellors = ['att12', 'att13', 'att14', 'lc3', 'in1', 'in2', 'in3'];
    const supers = ['super', 'logout', 'idle'];
    // Counsellors: some on the office list, some on today's new address with a computer registered earlier.
    const registered: Record<string, string> = {};
    for (const who of counsellors.slice(0, 4))
      registered[who] = cookieOf(await signIn(who, { ip: OFFICE_IP }))!;
    const results = await Promise.all([
      ...counsellors.map((who, i) =>
        i < 4
          ? signIn(who, { ip: NEW_ADDRESS, cookie: registered[who] })
          : signIn(who, { ip: OFFICE_IP }),
      ),
      ...supers.map((who) => signIn(who, { ip: OUTSIDE_IP, location: null })),
    ]);
    results.forEach((r, i) =>
      expect(r.statusCode, `${[...counsellors, ...supers][i]}: ${r.body}`).toBe(200),
    );
    expect(new Set(results.map((r) => r.json().accessToken)).size).toBe(10);
  });

  it('copes with one person signing in twice at the same moment from the same computer', async () => {
    const [a, b] = await Promise.all([
      signIn('in4', { ip: OFFICE_IP, cookie: token() }),
      signIn('in4', { ip: OFFICE_IP, cookie: token() }),
    ]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const same = token();
    const three = await Promise.all(
      [1, 2, 3].map(() => signIn('inleave', { ip: OFFICE_IP, cookie: same })),
    );
    for (const r of three) expect(r.statusCode, r.body).toBe(200);
    expect(await rows('inleave', 'approved')).toHaveLength(1);
  });

  it('falls back to the office address rule, unchanged, if the computer records cannot be used', async () => {
    await owner.query(`ALTER TABLE office_computers RENAME TO office_computers_off`);
    try {
      const onList = await signIn('lv1', { ip: OFFICE_IP, cookie: token() });
      expect(onList.statusCode, onList.body).toBe(200);
      const off = await signIn('lv1', { ip: NEW_ADDRESS, cookie: token() });
      expect(off.statusCode).toBe(403);
      expect(reason(off)).toBe('network');
    } finally {
      await owner.query(`ALTER TABLE office_computers_off RENAME TO office_computers`);
    }
  });

  it('does not change how the mobile app or a browser without a cookie signs in from the office list', async () => {
    const web = await signIn('mobile', { ip: OFFICE_IP });
    expect(web.statusCode).toBe(200);
    const outside = await signIn('adminmobile', { ip: OUTSIDE_IP, location: null });
    expect(outside.statusCode).toBe(403);
    expect(reason(outside)).toBe('network');
  });
});

describe('a computer that has not been used for months', () => {
  it('stops being trusted and has to be approved again', async () => {
    const mine = cookieOf(await signIn('lv1', { ip: OFFICE_IP }))!;
    expect((await signIn('lv1', { cookie: mine })).statusCode).toBe(200);
    await owner.query(
      `UPDATE office_computers SET last_used_at = now() - interval '100 days' WHERE user_id = $1`,
      [await userId('lv1')],
    );
    const stale = await signIn('lv1', { cookie: mine });
    expect(stale.statusCode).toBe(403);
    expect(reason(stale)).toBe('computer');
    // From an office address it is trusted again at once.
    expect((await signIn('lv1', { ip: OFFICE_IP, cookie: mine })).statusCode).toBe(200);
    expect((await signIn('lv1', { cookie: mine })).statusCode).toBe(200);
  });
});

describe('an office that goes by position alone', () => {
  const setMode = (mode: string) =>
    owner.query(`UPDATE branches SET office_check = $1 WHERE tenant_id = $2`, [mode, fx.tenantId]);
  afterEach(() => setMode('address_and_location'));

  it('is changed by a Super Admin and shown on the office', async () => {
    const branches = (await api.call('GET', '/branches', boss)).json() as
      { items?: { id: string; officeCheck: string }[] } | { id: string; officeCheck: string }[];
    const first = (Array.isArray(branches) ? branches : branches.items!)[0]!;
    expect(first.officeCheck).toBe('address_and_location');
    const res = await api.call('PATCH', `/branches/${first.id}`, boss, {
      officeCheck: 'location_only',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().officeCheck).toBe('location_only');
    expect(
      (await api.call('PATCH', `/branches/${first.id}`, boss, { officeCheck: 'anything' }))
        .statusCode,
    ).toBe(400);
  });

  it('lets a person in from any address when they are at the office, and still refuses anywhere else', async () => {
    await setMode('location_only');
    for (const ip of [NEW_ADDRESS, '203.0.113.9', OUTSIDE_IP]) {
      const ok = await signIn('att6', { ip });
      expect(ok.statusCode, `${ip}: ${ok.body}`).toBe(200);
    }
    for (const location of [
      null,
      { lat: 28.7, lng: 77.5, accuracy: 20 },
      { ...inOffice, accuracy: 900 },
      { ...inOffice, mocked: true },
    ]) {
      const refused = await signIn('att6', { location });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('OUTSIDE_OFFICE');
    }
    expect(await rows('att6')).toHaveLength(0); // no computer is recorded, and none is asked about
  });

  it('is the same as before for an office that keeps the default', async () => {
    const res = await signIn('att6', { ip: NEW_ADDRESS });
    expect(res.statusCode).toBe(403);
    expect(reason(res)).toBe('computer');
  });
});
