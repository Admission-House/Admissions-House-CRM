import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

/** Disposing a lead: the status, then the reason under it, and a comment where the reason is "Other". */
let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
let phoneCounter = 0;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.lc1 = await api.signIn('lc1', { office: true });

  const status = await api.call('POST', '/lead-statuses', t.sa!, {
    name: 'Ask to Call back',
    queue: 'followup',
    isOpen: true,
    requiresFollowup: false,
    requiresSubstatus: true,
  });
  expect(status.statusCode, status.body).toBe(201);
  ids.status = status.json().id;
  const busy = await api.call('POST', `/lead-statuses/${ids.status}/substatuses`, t.sa!, {
    name: 'Busy right now',
  });
  const other = await api.call('POST', `/lead-statuses/${ids.status}/substatuses`, t.sa!, {
    name: 'Other reasons',
    requiresComment: true,
  });
  const subs = other.json().substatuses as { id: string; name: string }[];
  ids.busy = subs.find((s) => s.name === 'Busy right now')!.id;
  ids.other = subs.find((s) => s.name === 'Other reasons')!.id;
  expect(busy.statusCode).toBe(201);

  const plain = await api.call('POST', '/lead-statuses', t.sa!, {
    name: 'Plain Status',
    queue: 'followup',
    isOpen: true,
    requiresFollowup: false,
  });
  ids.plain = plain.json().id;
  const foreign = await api.call('POST', `/lead-statuses/${ids.plain}/substatuses`, t.sa!, {
    name: 'Belongs elsewhere',
  });
  ids.foreign = (foreign.json().substatuses as { id: string }[])[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const newLead = async () => {
  const res = await api.call(
    'POST',
    '/leads',
    t.lc1!,
    {
      name: `Dispose Probe ${++phoneCounter}`,
      phone: `98765${String(40000 + phoneCounter)}`,
      sourceId: fx.sourceId('Website'),
    },
    OFFICE_IP,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const change = (leadId: string, body: Record<string, unknown>) =>
  api.call('POST', `/leads/${leadId}/status`, t.lc1!, { statusId: ids.status, ...body }, OFFICE_IP);

describe('disposing a lead', () => {
  it('lists the flags with each status and reason', async () => {
    const list = (await api.call('GET', '/lead-statuses', t.lc1!, undefined, OFFICE_IP)).json() as {
      id: string;
      requiresSubstatus: boolean;
      substatuses: { name: string; requiresComment: boolean }[];
    }[];
    const s = list.find((x) => x.id === ids.status)!;
    expect(s.requiresSubstatus).toBe(true);
    expect(s.substatuses.map((x) => [x.name, x.requiresComment])).toEqual([
      ['Busy right now', false],
      ['Other reasons', true],
    ]);
  });

  it('needs the reason when the status asks for one', async () => {
    const lead = await newLead();
    const res = await change(lead, {});
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('SUBSTATUS_REQUIRED');
    const ok = await change(lead, { substatusId: ids.busy });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().substatus).toMatchObject({ name: 'Busy right now' });
  });

  it('needs a comment where the reason says so, and takes it when given', async () => {
    const lead = await newLead();
    const none = await change(lead, { substatusId: ids.other });
    expect(none.statusCode).toBe(400);
    expect(errorCode(none)).toBe('COMMENT_REQUIRED');
    expect((await change(lead, { substatusId: ids.other, remark: '   ' })).statusCode).toBe(400);
    const ok = await change(lead, {
      substatusId: ids.other,
      remark: 'Wants to speak to the father first',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const history = (
      await api.call('GET', `/leads/${lead}/activities`, t.lc1!, undefined, OFFICE_IP)
    )
      .json()
      .items.map(
        (a: { newValue: string | null; remark: string | null }) =>
          `${a.newValue ?? ''} ${a.remark ?? ''}`,
      );
    expect(history.join(' | ')).toContain('Ask to Call back / Other reasons');
    expect(history.join(' | ')).toContain('Wants to speak to the father first');
  });

  it('refuses a reason that belongs to another status, and asks for nothing on a plain status', async () => {
    const lead = await newLead();
    expect(errorCode(await change(lead, { substatusId: ids.foreign }))).toBe('STATUS_INVALID');
    const plain = await api.call(
      'POST',
      `/leads/${lead}/status`,
      t.lc1!,
      { statusId: ids.plain },
      OFFICE_IP,
    );
    expect(plain.statusCode, plain.body).toBe(200);
  });

  it('applies to a change of many leads at once', async () => {
    const a = await newLead();
    const b = await newLead();
    await owner.query(`UPDATE users SET manager_id = NULL WHERE id = $1`, [fx.user('lc1').id]);
    const missing = await api.call(
      'POST',
      '/leads/bulk/status',
      t.sa!,
      { leadIds: [a, b], statusId: ids.status },
      undefined,
    );
    expect(errorCode(missing)).toBe('SUBSTATUS_REQUIRED');
    const noComment = await api.call('POST', '/leads/bulk/status', t.sa!, {
      leadIds: [a, b],
      statusId: ids.status,
      substatusId: ids.other,
    });
    expect(errorCode(noComment)).toBe('COMMENT_REQUIRED');
    const ok = await api.call('POST', '/leads/bulk/status', t.sa!, {
      leadIds: [a, b],
      statusId: ids.status,
      substatusId: ids.other,
      remark: 'Campaign ended',
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('can be changed in settings: whether a reason needs a comment, and whether the status needs a reason', async () => {
    const turnedOff = await api.call('PATCH', `/lead-substatuses/${ids.other}`, t.sa!, {
      requiresComment: false,
    });
    expect(turnedOff.statusCode, turnedOff.body).toBe(200);
    const lead = await newLead();
    expect((await change(lead, { substatusId: ids.other })).statusCode).toBe(200);
    await api.call('PATCH', `/lead-substatuses/${ids.other}`, t.sa!, { requiresComment: true });

    const noReason = await api.call('PATCH', `/lead-statuses/${ids.status}`, t.sa!, {
      requiresSubstatus: false,
    });
    expect(noReason.statusCode, noReason.body).toBe(200);
    expect((await change(await newLead(), {})).statusCode).toBe(200);
    expect((await api.call('PATCH', `/lead-substatuses/${ids.other}`, t.sa!, {})).statusCode).toBe(
      400,
    );
  });

  it('is for those who manage the settings: a counsellor cannot change them', async () => {
    expect(
      (
        await api.call(
          'PATCH',
          `/lead-substatuses/${ids.other}`,
          t.lc1!,
          { requiresComment: false },
          OFFICE_IP,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api.call(
          'PATCH',
          `/lead-statuses/${ids.status}`,
          t.lc1!,
          { requiresSubstatus: true },
          OFFICE_IP,
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('the list a person can choose from', () => {
  it('shows every status with whether it is offered, and a status can be switched out of the list', async () => {
    const hidden = await api.call('POST', '/lead-statuses', t.sa!, {
      name: 'Old Legacy Status',
      queue: 'followup',
      isOpen: true,
      requiresFollowup: false,
      selectable: false,
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    ids.hidden = hidden.json().id;
    const list = (await api.call('GET', '/lead-statuses', t.lc1!, undefined, OFFICE_IP)).json() as {
      id: string;
      selectable: boolean;
    }[];
    expect(list.find((x) => x.id === ids.hidden)!.selectable).toBe(false);
    expect(list.find((x) => x.id === ids.status)!.selectable).toBe(true);
    const flip = await api.call('PATCH', `/lead-statuses/${ids.hidden}`, t.sa!, {
      selectable: true,
    });
    expect(flip.statusCode, flip.body).toBe(200);
    expect(flip.json().selectable).toBe(true);
    await api.call('PATCH', `/lead-statuses/${ids.hidden}`, t.sa!, { selectable: false });
  });

  it('refuses a status that is not offered, for one lead and for many', async () => {
    const lead = await newLead();
    const one = await api.call(
      'POST',
      `/leads/${lead}/status`,
      t.lc1!,
      { statusId: ids.hidden },
      OFFICE_IP,
    );
    expect(one.statusCode).toBe(400);
    expect(errorCode(one)).toBe('STATUS_NOT_OFFERED');
    const many = await api.call('POST', '/leads/bulk/status', t.sa!, {
      leadIds: [lead],
      statusId: ids.hidden,
    });
    expect(many.statusCode).toBe(400);
    expect(errorCode(many)).toBe('STATUS_NOT_OFFERED');
    expect(
      (await api.call('GET', `/leads/${lead}`, t.lc1!, undefined, OFFICE_IP)).json().status.id,
    ).not.toBe(ids.hidden);
  });

  it('leaves a lead that already holds such a status alone, and still lets it be saved with a note', async () => {
    const lead = await newLead();
    await owner.query(`UPDATE leads SET status_id = $1 WHERE id = $2`, [ids.hidden, lead]);
    const same = await api.call(
      'POST',
      `/leads/${lead}/status`,
      t.lc1!,
      { statusId: ids.hidden, remark: 'called, no answer' },
      OFFICE_IP,
    );
    expect(same.statusCode, same.body).toBe(200);
    const away = await api.call(
      'POST',
      `/leads/${lead}/status`,
      t.lc1!,
      { statusId: ids.status, substatusId: ids.busy },
      OFFICE_IP,
    );
    expect(away.statusCode, away.body).toBe(200);
  });
});

describe('finding leads by when they came in, and junk leads', () => {
  const list = async (query: string) =>
    (await api.call('GET', `/leads?${query}`, t.sa!)).json() as {
      items: { id: string; createdAt: string; status: { id: string } }[];
    };

  it('lists the oldest first when asked, and the newest first otherwise', async () => {
    const first = await newLead();
    await new Promise((r) => setTimeout(r, 30));
    const second = await newLead();
    const asc = (await list('sort=oldest&limit=100')).items.map((l) => l.id);
    expect(asc.indexOf(first)).toBeLessThan(asc.indexOf(second));
    const desc = (await list('limit=100')).items.map((l) => l.id);
    expect(desc.indexOf(second)).toBeLessThan(desc.indexOf(first));
    const page1 = await list('sort=oldest&limit=1');
    expect(page1.items).toHaveLength(1);
  });

  it('shows only the leads received after a moment, for "the last few hours or days"', async () => {
    await newLead();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      (await list(`createdAfter=${encodeURIComponent(hourAgo)}&limit=100`)).items.length,
    ).toBeGreaterThan(0);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect((await list(`createdAfter=${encodeURIComponent(later)}&limit=100`)).items).toHaveLength(
      0,
    );
    expect((await api.call('GET', '/leads?createdAfter=yesterday', t.sa!)).statusCode).toBe(400);
  });

  it('shows or hides the leads whose status is marked as junk', async () => {
    const junkStatus = (
      await api.call('POST', '/lead-statuses', t.sa!, {
        name: 'Junk Probe',
        queue: 'closed',
        isOpen: false,
        requiresFollowup: false,
        isJunk: true,
      })
    ).json().id as string;
    const junkLead = await newLead();
    await owner.query(`UPDATE leads SET status_id = $1 WHERE id = $2`, [junkStatus, junkLead]);
    const only = (await list('junk=only&limit=100')).items.map((l) => l.id);
    expect(only).toContain(junkLead);
    expect((await list('junk=hide&limit=100')).items.map((l) => l.id)).not.toContain(junkLead);
    expect((await list('limit=100')).items.map((l) => l.id)).toContain(junkLead);
    const flag = (
      (await api.call('GET', '/lead-statuses', t.sa!)).json() as { id: string; isJunk: boolean }[]
    ).find((s) => s.id === junkStatus);
    expect(flag?.isJunk).toBe(true);
  });
});

describe('a won lead', () => {
  const wonNotices = async (leadId: string) =>
    (
      await owner.query(
        `SELECT user_id, payload FROM notifications WHERE type = 'system' AND payload->>'event' = 'lead_won' AND payload->>'leadId' = $1`,
        [leadId],
      )
    ).rows as { user_id: string; payload: Record<string, unknown> }[];
  const activeUsers = async () =>
    Number(
      (
        await owner.query(`SELECT count(*) FROM users WHERE tenant_id = $1 AND status = 'active'`, [
          fx.tenantId,
        ])
      ).rows[0].count,
    );

  beforeAll(async () => {
    const won = await api.call('POST', '/lead-statuses', t.sa!, {
      name: 'Admission Probe',
      queue: 'closed',
      isOpen: false,
      requiresFollowup: false,
      isWon: true,
    });
    expect(won.statusCode, won.body).toBe(201);
    ids.won = won.json().id;
    ids.won2 = (
      await api.call('POST', '/lead-statuses', t.sa!, {
        name: 'Admitted Probe',
        queue: 'closed',
        isOpen: false,
        requiresFollowup: false,
        isWon: true,
      })
    ).json().id;
  });

  it('tells every active person in the company who won it, once, naming the counsellor who holds the lead', async () => {
    const lead = await newLead();
    const res = await api.call(
      'POST',
      `/leads/${lead}/status`,
      t.lc1!,
      { statusId: ids.won },
      OFFICE_IP,
    );
    expect(res.statusCode, res.body).toBe(200);
    const notes = await wonNotices(lead);
    expect(notes).toHaveLength(await activeUsers());
    expect(notes.map((n) => n.user_id)).toEqual(
      expect.arrayContaining([fx.user('super').id, fx.user('lc2').id, fx.user('lc1').id]),
    );
    expect(notes[0]!.payload).toMatchObject({
      event: 'lead_won',
      winnerId: fx.user('lc1').id,
      winnerName: 'lc1',
      status: 'Admission Probe',
    });
    expect(typeof notes[0]!.payload.leadNo).toBe('number');
    // The student's details stay out of it: most people cannot open someone else's lead.
    expect(JSON.stringify(notes[0]!.payload)).not.toContain('Dispose Probe');
  });

  it('does not announce it again for a move between two "won" statuses, or for a quick move out and back', async () => {
    const lead = await newLead();
    await api.call('POST', `/leads/${lead}/status`, t.lc1!, { statusId: ids.won }, OFFICE_IP);
    const first = (await wonNotices(lead)).length;
    expect(
      (await api.call('POST', `/leads/${lead}/status`, t.lc1!, { statusId: ids.won2 }, OFFICE_IP))
        .statusCode,
    ).toBe(200);
    expect(
      (await api.call('POST', `/leads/${lead}/status`, t.lc1!, { statusId: ids.plain }, OFFICE_IP))
        .statusCode,
    ).toBe(200);
    expect(
      (await api.call('POST', `/leads/${lead}/status`, t.lc1!, { statusId: ids.won }, OFFICE_IP))
        .statusCode,
    ).toBe(200);
    expect(await wonNotices(lead)).toHaveLength(first);
  });

  it('announces each lead won through a bulk change, and nothing for a status that is not "won"', async () => {
    const [a, b] = [await newLead(), await newLead()];
    const plain = await newLead();
    expect(
      (
        await api.call('POST', '/leads/bulk/status', t.sa!, {
          leadIds: [plain],
          statusId: ids.plain,
        })
      ).statusCode,
    ).toBe(200);
    expect(await wonNotices(plain)).toHaveLength(0);
    const res = await api.call('POST', '/leads/bulk/status', t.sa!, {
      leadIds: [a, b],
      statusId: ids.won,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await wonNotices(a)).length).toBeGreaterThan(0);
    expect((await wonNotices(b)).length).toBeGreaterThan(0);
    // The win is the counsellor's who holds the lead, not the Super Admin's who changed the status.
    expect((await wonNotices(a))[0]!.payload.winnerId).toBe(fx.user('lc1').id);
  });

  it('refuses a status that would be both "won" and junk, and shows the flag in the list', async () => {
    const both = await api.call('POST', '/lead-statuses', t.sa!, {
      name: 'Both Probe',
      queue: 'closed',
      isOpen: false,
      requiresFollowup: false,
      isWon: true,
      isJunk: true,
    });
    expect(both.statusCode).toBe(400);
    expect(errorCode(both)).toBe('WON_AND_JUNK');
    expect(
      (await api.call('PATCH', `/lead-statuses/${ids.won}`, t.sa!, { isJunk: true })).statusCode,
    ).toBe(400);
    const flag = (
      (await api.call('GET', '/lead-statuses', t.sa!)).json() as { id: string; isWon: boolean }[]
    ).find((s) => s.id === ids.won);
    expect(flag?.isWon).toBe(true);
  });
});
