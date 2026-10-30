import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { FollowUpReminderService } from '../src/followups/followup-reminder.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2', 'lc3', 'counsellor2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(600_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const idOf = (name: string) => fx.user(name).id;
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

const statusId = async (name: string) =>
  (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 AND name = $2`, [fx.tenantId, name])).rows[0].id as string;

async function lead(token: string, over: Record<string, unknown> = {}) {
  const res = await api.call('POST', '/leads', token, { name: 'FU Lead', phone: phone(), sourceId: fx.sourceId('Website'), ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const addFollowUp = (token: string, leadId: string, body: Record<string, unknown>) => api.call('POST', `/leads/${leadId}/followups`, token, body);
const nextFollowup = async (leadId: string) => (await owner.query(`SELECT next_followup_at FROM leads WHERE id = $1`, [leadId])).rows[0].next_followup_at as Date | null;
const followUpRow = async (id: string) => (await owner.query(`SELECT * FROM followups WHERE id = $1`, [id])).rows[0];
const activityTypes = async (token: string, leadId: string) =>
  (await api.call('GET', `/leads/${leadId}/activities?limit=100`, token)).json().items.map((a: { type: string; field: string | null }) => `${a.type}:${a.field ?? ''}`);

/** A time later today, whatever the hour: halfway between now and the end of the company's day. */
const laterToday = async () =>
  (await owner.query(
    `SELECT (now() + ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day') AT TIME ZONE 'Asia/Kolkata' - now()) / 2) AS t`,
  )).rows[0].t as Date;

const setDue = (id: string, sql: string) => owner.query(`UPDATE followups SET due_at = ${sql} WHERE id = $1`, [id]);

// ==================================================================== create

describe('setting a follow-up', () => {
  it('belongs to whoever owns the lead, shows the lead, and sets the lead\'s next follow-up', async () => {
    const l = await lead(t.lc1!);
    const res = await addFollowUp(t.lc1!, l.id, { dueAt: inMinutes(120), note: 'Ask about fees', remindBeforeMin: 30 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      note: 'Ask about fees', remindBeforeMin: 30, doneAt: null, owner: { name: 'lc1' },
      lead: { id: l.id, leadNo: l.leadNo, name: 'FU Lead', status: 'New', isOpen: true },
    });
    expect((await nextFollowup(l.id))?.getTime()).toBe(new Date(res.json().dueAt).getTime());
    expect(await activityTypes(t.lc1!, l.id)).toContain('followup:due_at');
  });

  it('keeps the lead\'s next follow-up at the earliest one that is open', async () => {
    const l = await lead(t.lc1!);
    const late = await addFollowUp(t.lc1!, l.id, { dueAt: inMinutes(600) });
    const early = await addFollowUp(t.lc1!, l.id, { dueAt: inMinutes(60) });
    expect((await nextFollowup(l.id))?.getTime()).toBe(new Date(early.json().dueAt).getTime());
    expect(late.statusCode).toBe(201);

    const listed = await api.call('GET', `/leads/${l.id}/followups`, t.lc1!);
    expect(listed.json().map((f: { id: string }) => f.id)).toEqual([early.json().id, late.json().id]);
  });

  it('is the job of the person who sets it, when nobody owns the lead yet', async () => {
    const l = await lead(t.admin!, { assignTo: null });
    const res = await addFollowUp(t.admin!, l.id, { dueAt: inMinutes(60) });
    expect(res.json().owner).toMatchObject({ name: 'admin' });
  });

  it.each([
    ['in the past', { dueAt: '2020-01-01T10:00:00Z' }, 400, 'FOLLOWUP_IN_PAST'],
    ['without a time zone', { dueAt: '2030-01-01T10:00:00' }, 400, 'VALIDATION_FAILED'],
    ['with a reminder far too early', { dueAt: inMinutes(60), remindBeforeMin: 99999 }, 400, 'VALIDATION_FAILED'],
  ])('refuses a follow-up %s', async (_n, body, status, code) => {
    const l = await lead(t.lc1!);
    const res = await addFollowUp(t.lc1!, l.id, body);
    expect(res.statusCode, res.body).toBe(status);
    expect(errorCode(res)).toBe(code);
  });

  it('refuses one on a closed lead, or on a lead the person cannot see', async () => {
    const closed = await lead(t.lc1!);
    await api.call('POST', `/leads/${closed.id}/status`, t.lc1!, { statusId: await statusId('Not Interested') });
    expect(errorCode(await addFollowUp(t.lc1!, closed.id, { dueAt: inMinutes(60) }))).toBe('LEAD_CLOSED');

    const theirs = await lead(t.lc2!);
    expect((await addFollowUp(t.lc1!, theirs.id, { dueAt: inMinutes(60) })).statusCode).toBe(404);
  });
});

// ================================================================= reschedule

describe('moving a follow-up', () => {
  it('changes the time, the lead\'s next follow-up and the history, and earns a new reminder', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    await owner.query(`UPDATE followups SET reminded_at = now() WHERE id = $1`, [f.id]);

    const moved = await api.call('PATCH', `/followups/${f.id}`, t.lc2!, { dueAt: inMinutes(300), note: 'Call after lunch' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().note).toBe('Call after lunch');
    expect(new Date(moved.json().dueAt).getTime()).toBeGreaterThan(Date.parse(f.dueAt));
    expect((await nextFollowup(l.id))?.getTime()).toBe(new Date(moved.json().dueAt).getTime());
    expect((await followUpRow(f.id)).reminded_at).toBeNull();
    const entries = (await api.call('GET', `/leads/${l.id}/activities?limit=50`, t.lc2!)).json().items.filter((a: { type: string }) => a.type === 'followup');
    expect(entries.some((a: { oldValue: string | null; newValue: string | null }) => a.oldValue && a.newValue)).toBe(true);
  });

  it('keeps the reminder as it was when only the note changes', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    await owner.query(`UPDATE followups SET reminded_at = now() WHERE id = $1`, [f.id]);
    await api.call('PATCH', `/followups/${f.id}`, t.lc2!, { note: 'Only the note' });
    expect((await followUpRow(f.id)).reminded_at).not.toBeNull();
  });

  it('can be done by the Admin of the team, not by another Admin or a colleague', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    expect((await api.call('PATCH', `/followups/${f.id}`, t.admin!, { note: 'Admin edit' })).statusCode).toBe(200);
    expect((await api.call('PATCH', `/followups/${f.id}`, t.admin2!, { note: 'x' })).statusCode).toBe(404);
    expect((await api.call('PATCH', `/followups/${f.id}`, t.lc1!, { note: 'x' })).statusCode).toBe(404);
  });

  it('refuses a past time, an empty change and a follow-up that is already done', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    expect(errorCode(await api.call('PATCH', `/followups/${f.id}`, t.lc2!, { dueAt: '2020-01-01T10:00:00Z' }))).toBe('FOLLOWUP_IN_PAST');
    expect(errorCode(await api.call('PATCH', `/followups/${f.id}`, t.lc2!, {}))).toBe('VALIDATION_FAILED');
    await api.call('POST', `/followups/${f.id}/done`, t.lc2!, {});
    expect(errorCode(await api.call('PATCH', `/followups/${f.id}`, t.lc2!, { note: 'late' }))).toBe('FOLLOWUP_CLOSED');
  });
});

// ======================================================================= done

describe('finishing a follow-up', () => {
  it('moves the lead on to its next follow-up, or to none', async () => {
    const l = await lead(t.lc2!);
    const first = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    const second = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(600) })).json();

    const done = await api.call('POST', `/followups/${first.id}/done`, t.lc2!, { note: 'Spoke to the mother' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ note: 'Spoke to the mother' });
    expect(done.json().doneAt).not.toBeNull();
    expect((await nextFollowup(l.id))?.getTime()).toBe(new Date(second.dueAt).getTime());

    await api.call('POST', `/followups/${second.id}/done`, t.lc2!, {});
    expect(await nextFollowup(l.id)).toBeNull();
    expect(errorCode(await api.call('POST', `/followups/${second.id}/done`, t.lc2!, {}))).toBe('FOLLOWUP_CLOSED');
  });

  it('takes a lead out of the Missed queue', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    await setDue(f.id, `now() - interval '1 hour'`);
    await owner.query(`UPDATE leads SET next_followup_at = now() - interval '1 hour' WHERE id = $1`, [l.id]);
    expect((await api.call('GET', `/leads/${l.id}`, t.lc2!)).json().queue).toBe('missed');

    await api.call('POST', `/followups/${f.id}/done`, t.lc2!, {});
    expect((await api.call('GET', `/leads/${l.id}`, t.lc2!)).json().queue).toBe('fresh');
  });

  it('can be cancelled', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(60) })).json();
    expect((await api.call('DELETE', `/followups/${f.id}`, t.lc2!)).statusCode).toBe(204);
    expect(await nextFollowup(l.id)).toBeNull();
    expect((await api.call('DELETE', `/followups/${f.id}`, t.lc2!)).statusCode).toBe(404);
    expect(await activityTypes(t.lc2!, l.id)).toContain('followup:cancelled');
  });
});

// ======================================================================= lists

describe('the follow-up lists', () => {
  const made: Record<string, { lead: string; id: string }> = {};

  beforeAll(async () => {
    const later = (await laterToday()).toISOString();
    const specs: [string, () => Promise<void>][] = [];
    for (const name of ['overdue', 'today', 'upcoming', 'done']) {
      const l = await lead(t.lc3!, { name: `List ${name}` });
      const f = (await addFollowUp(t.lc3!, l.id, { dueAt: inMinutes(60) })).json();
      made[name] = { lead: l.id, id: f.id };
      specs.push([name, async () => {
        if (name === 'overdue') await setDue(f.id, `now() - interval '3 hours'`);
        if (name === 'today') await setDue(f.id, `'${later}'::timestamptz`);
        if (name === 'upcoming') await setDue(f.id, `now() + interval '3 days'`);
      }]);
    }
    for (const [, apply] of specs) await apply();
    await api.call('POST', `/followups/${made.done!.id}/done`, t.lc3!, {});
  });

  const idsIn = async (token: string, query: string) => (await api.call('GET', `/followups?${query}`, token)).json().items.map((f: { id: string }) => f.id) as string[];

  it('keep the buckets apart: overdue, still to come today, upcoming, and done', async () => {
    expect(await idsIn(t.lc3!, 'bucket=overdue')).toEqual([made.overdue!.id]);
    expect(await idsIn(t.lc3!, 'bucket=today')).toEqual([made.today!.id]);
    expect(await idsIn(t.lc3!, 'bucket=upcoming')).toEqual([made.upcoming!.id]);
    expect(await idsIn(t.lc3!, 'bucket=done')).toEqual([made.done!.id]);
  });

  it('count the open buckets for the badges', async () => {
    expect((await api.call('GET', '/followups/summary', t.lc3!)).json()).toEqual({ overdue: 1, today: 1, upcoming: 1 });
  });

  it('show a counsellor their own, an Admin their team\'s, and nobody else\'s', async () => {
    expect(await idsIn(t.lc1!, 'bucket=overdue')).not.toContain(made.overdue!.id);
    expect(await idsIn(t.admin!, `bucket=overdue&userId=${idOf('lc3')}`)).toEqual([made.overdue!.id]);
    expect(await idsIn(t.admin!, 'bucket=overdue&limit=100')).toContain(made.overdue!.id);
    expect(await idsIn(t.admin2!, 'bucket=overdue&limit=100')).not.toContain(made.overdue!.id);
    expect(await idsIn(t.admin2!, `bucket=overdue&userId=${idOf('lc3')}`)).toEqual([]);
    expect(await idsIn(t.sa!, 'bucket=overdue&limit=100')).toContain(made.overdue!.id);
  });

  it('show the lead with each follow-up, and put the soonest first', async () => {
    const items = (await api.call('GET', '/followups?bucket=overdue&limit=100', t.sa!)).json().items;
    const times = items.map((i: { dueAt: string }) => Date.parse(i.dueAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const mine = items.find((i: { id: string }) => i.id === made.overdue!.id);
    expect(mine).toMatchObject({ lead: { name: 'List overdue', status: 'New' }, owner: { name: 'lc3' } });
  });

  it('page through a longer list exactly once, in order', async () => {
    for (let i = 0; i < 5; i++) {
      const l = await lead(t.lc3!);
      const f = (await addFollowUp(t.lc3!, l.id, { dueAt: inMinutes(60) })).json();
      await setDue(f.id, `now() + interval '${10 + i} days'`);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/followups?bucket=upcoming&limit=2${cursor ? `&cursor=${cursor}` : ''}`, t.lc3!);
      seen.push(...res.json().items.map((f: { id: string }) => f.id));
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('are for those who manage follow-ups, and refuse a bad bucket', async () => {
    expect(errorCode(await api.call('GET', '/followups?bucket=someday', t.lc3!))).toBe('VALIDATION_FAILED');
  });
});

// =================================================================== reminders

describe('reminders', () => {
  const reminders = () => app.get(FollowUpReminderService);
  const remindersFor = async (name: string) =>
    (await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'followup_due'`, [fx.tenantId, idOf(name)])).rows.map((r) => r.payload);

  it('are sent once, shortly before a follow-up is due, to its owner', async () => {
    const l = await lead(t.lc1!, { name: 'Remind Me' });
    const soon = (await addFollowUp(t.lc1!, l.id, { dueAt: inMinutes(5), remindBeforeMin: 10, note: 'Fee question' })).json();
    const later = await lead(t.lc1!);
    await addFollowUp(t.lc1!, later.id, { dueAt: inMinutes(180), remindBeforeMin: 10 });

    expect(await reminders().runOnce()).toBeGreaterThanOrEqual(1);
    const sent = await remindersFor('lc1');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: 'followup_due', followUpId: soon.id, leadId: l.id, name: 'Remind Me', note: 'Fee question' });
    expect(JSON.stringify(sent[0])).not.toContain('9800000');

    expect(await reminders().runOnce()).toBe(0); // not twice
    expect(await remindersFor('lc1')).toHaveLength(1);
  });

  it('are sent again if the follow-up is moved, and not for one that is done or cancelled', async () => {
    const l = await lead(t.lc2!);
    const f = (await addFollowUp(t.lc2!, l.id, { dueAt: inMinutes(5), remindBeforeMin: 10 })).json();
    await reminders().runOnce();
    const before = (await remindersFor('lc2')).length;
    expect(before).toBe(1);

    await api.call('PATCH', `/followups/${f.id}`, t.lc2!, { dueAt: inMinutes(4) });
    await reminders().runOnce();
    expect(await remindersFor('lc2')).toHaveLength(2);

    const done = await lead(t.lc2!);
    const d = (await addFollowUp(t.lc2!, done.id, { dueAt: inMinutes(5), remindBeforeMin: 10 })).json();
    await api.call('POST', `/followups/${d.id}/done`, t.lc2!, {});
    const gone = await lead(t.lc2!);
    const g = (await addFollowUp(t.lc2!, gone.id, { dueAt: inMinutes(5), remindBeforeMin: 10 })).json();
    await api.call('DELETE', `/followups/${g.id}`, t.lc2!);
    await reminders().runOnce();
    expect(await remindersFor('lc2')).toHaveLength(2);
  });

  it('go to whoever owns the lead now, after it is handed over', async () => {
    const l = await lead(t.lc3!, { name: 'Handed Over' });
    await addFollowUp(t.lc3!, l.id, { dueAt: inMinutes(5), remindBeforeMin: 10 });
    await api.call('POST', `/leads/${l.id}/assign`, t.admin!, { userId: idOf('lc1') });
    const before = (await remindersFor('lc1')).length;
    await reminders().runOnce();
    const after = await remindersFor('lc1');
    expect(after).toHaveLength(before + 1);
    expect(after.some((p) => p.name === 'Handed Over')).toBe(true);
    expect((await remindersFor('lc3')).some((p) => p.name === 'Handed Over')).toBe(false);
  });

  it('are not sent for a lead that has been deleted', async () => {
    const l = await lead(t.lc3!, { name: 'Deleted Lead' });
    await addFollowUp(t.lc3!, l.id, { dueAt: inMinutes(5), remindBeforeMin: 10 });
    await api.call('DELETE', `/leads/${l.id}`, t.sa!);
    await reminders().runOnce();
    expect((await remindersFor('lc3')).some((p) => p.name === 'Deleted Lead')).toBe(false);
  });
});
