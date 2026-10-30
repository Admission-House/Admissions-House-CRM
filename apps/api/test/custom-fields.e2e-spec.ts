import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

let counter = 0;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const newLead = async (token: string) => {
  const res = await api.call('POST', '/leads', token, { name: 'Field Lead', phone: `9${String(100_000_000 + ++counter).padStart(9, '0')}`, sourceId: fx.sourceId('Website') });
  return res.json().id as string;
};
const make = (body: Record<string, unknown>) => api.call('POST', '/custom-fields', t.sa!, body);

describe('defining fields', () => {
  it('lets the Super Admin add each kind of field', async () => {
    const text = await make({ key: 'father_name', label: "Father's name", dataType: 'text' });
    expect(text.statusCode, text.body).toBe(201);
    expect(text.json()).toMatchObject({ key: 'father_name', dataType: 'text', isRequired: false, isActive: true, options: [] });
    ids.text = text.json().id;
    ids.num = (await make({ key: 'percentage', label: '12th percentage', dataType: 'number' })).json().id;
    ids.date = (await make({ key: 'visit_on', label: 'Campus visit', dataType: 'date' })).json().id;
    const sel = await make({ key: 'budget', label: 'Budget', dataType: 'select', isRequired: true, options: [{ value: 'low', label: 'Under 1 lakh' }, { value: 'high', label: 'Above 1 lakh' }] });
    expect(sel.json()).toMatchObject({ isRequired: true, options: [{ value: 'low' }, { value: 'high' }] });
    ids.sel = sel.json().id;
    expect((await api.call('GET', '/custom-fields', t.lc1!)).json().map((f: { key: string }) => f.key)).toEqual(['father_name', 'percentage', 'visit_on', 'budget']);
  });

  it('refuses a repeated key, a dropdown without options, options on other types, and bad keys', async () => {
    expect(errorCode(await make({ key: 'father_name', label: 'Again', dataType: 'text' }))).toBe('FIELD_EXISTS');
    for (const bad of [
      { key: 'x1', label: 'X', dataType: 'select' },
      { key: 'x2', label: 'X', dataType: 'text', options: [{ value: 'a', label: 'A' }] },
      { key: 'x3', label: 'X', dataType: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] },
      { key: 'Bad Key', label: 'X', dataType: 'text' },
      { key: 'x4', label: 'X', dataType: 'file' },
    ]) expect(errorCode(await make(bad))).toBe('VALIDATION_FAILED');
  });

  it('is for the Super Admin; others only read', async () => {
    expect((await api.call('POST', '/custom-fields', t.admin!, { key: 'nope', label: 'Nope', dataType: 'text' })).statusCode).toBe(403);
    expect((await api.call('PATCH', `/custom-fields/${ids.text}`, t.lc1!, { label: 'Changed' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/custom-fields' })).statusCode).toBe(401);
  });
});

describe('filling them in on a lead', () => {
  it('saves valid values, shows them with the definitions, and records the change', async () => {
    const lead = await newLead(t.lc1!);
    const res = await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: ' Ramesh ', percentage: '87.5', visit_on: '2026-12-01', budget: 'low' } });
    expect(res.statusCode, res.body).toBe(200);
    const byKey = Object.fromEntries(res.json().map((f: { key: string; value: string | null }) => [f.key, f.value]));
    expect(byKey).toEqual({ father_name: 'Ramesh', percentage: '87.5', visit_on: '2026-12-01', budget: 'low' });
    expect((await api.call('GET', `/leads/${lead}/custom-fields`, t.lc1!)).json()).toHaveLength(4);

    const trail = (await api.call('GET', `/leads/${lead}/activities?limit=50`, t.lc1!)).json().items.filter((a: { type: string }) => a.type === 'field_change');
    expect(trail.map((a: { field: string; newValue: string }) => `${a.field}=${a.newValue}`).sort()).toEqual(['12th percentage=87.5', 'Budget=low', 'Campus visit=2026-12-01', "Father's name=Ramesh"]);
  });

  it('changes only what was sent, and clears with null', async () => {
    const lead = await newLead(t.lc1!);
    await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: 'A', budget: 'high' } });
    const res = await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: null } });
    const byKey = Object.fromEntries(res.json().map((f: { key: string; value: string | null }) => [f.key, f.value]));
    expect(byKey).toMatchObject({ father_name: null, budget: 'high' });
    const before = (await api.call('GET', `/leads/${lead}/activities?limit=50`, t.lc1!)).json().items.length;
    await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { budget: 'high' } }); // same value: nothing to record
    expect((await api.call('GET', `/leads/${lead}/activities?limit=50`, t.lc1!)).json().items.length).toBe(before);
  });

  it('refuses bad values with a message for each, saving none of them', async () => {
    const lead = await newLead(t.lc1!);
    const res = await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: 'Fine', percentage: 'lots', visit_on: '2026-02-30', budget: 'medium', unknown: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors.map((e: { field: string }) => e.field).sort()).toEqual(['budget', 'percentage', 'unknown', 'visit_on']);
    expect((await api.call('GET', `/leads/${lead}/custom-fields`, t.lc1!)).json().every((f: { value: unknown }) => f.value === null)).toBe(true);
  });

  it('does not let a required field be cleared', async () => {
    const lead = await newLead(t.lc1!);
    await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { budget: 'low' } });
    const res = await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { budget: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fieldErrors[0]).toMatchObject({ field: 'budget', message: 'Budget is required' });
  });

  it('follows who may see and change the lead', async () => {
    const lead = await newLead(t.lc2!);
    expect((await api.call('GET', `/leads/${lead}/custom-fields`, t.lc1!)).statusCode).toBe(404);
    expect((await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: 'x' } })).statusCode).toBe(404);
    expect((await api.call('PUT', `/leads/${lead}/custom-fields`, t.admin!, { values: { father_name: 'x' } })).statusCode).toBe(200);
    expect(errorCode(await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc2!, { values: {} }))).toBe('VALIDATION_FAILED');
  });
});

describe('changing and retiring fields', () => {
  it('renames, reorders and changes a dropdown, but not past values in use', async () => {
    const lead = await newLead(t.lc1!);
    await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { budget: 'low' } });
    const renamed = await api.call('PATCH', `/custom-fields/${ids.sel}`, t.sa!, { label: 'Fee budget', options: [{ value: 'low', label: 'Below 1 lakh' }, { value: 'high', label: 'Above 1 lakh' }, { value: 'mid', label: 'Middle' }] });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ label: 'Fee budget', key: 'budget', dataType: 'select' });
    expect(renamed.json().options.map((o: { value: string }) => o.value)).toEqual(['low', 'high', 'mid']);

    const drop = await api.call('PATCH', `/custom-fields/${ids.sel}`, t.sa!, { options: [{ value: 'high', label: 'Above 1 lakh' }] });
    expect(drop.statusCode).toBe(409);
    expect(errorCode(drop)).toBe('OPTION_IN_USE');
    expect(errorCode(await api.call('PATCH', `/custom-fields/${ids.text}`, t.sa!, { options: [{ value: 'a', label: 'A' }] }))).toBe('OPTIONS_NOT_ALLOWED');
    expect(errorCode(await api.call('PATCH', `/custom-fields/${ids.text}`, t.sa!, {}))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('PATCH', `/custom-fields/${ids.text}`, t.sa!, { dataType: 'number' }))).toBe('VALIDATION_FAILED');
  });

  it('hides a field that is switched off but keeps what was entered, and brings it back', async () => {
    const lead = await newLead(t.lc1!);
    await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: 'Kept' } });
    await api.call('PATCH', `/custom-fields/${ids.text}`, t.sa!, { isActive: false });
    expect((await api.call('GET', '/custom-fields', t.lc1!)).json().map((f: { key: string }) => f.key)).not.toContain('father_name');
    expect((await api.call('GET', '/custom-fields?includeInactive=true', t.sa!)).json().map((f: { key: string }) => f.key)).toContain('father_name');
    expect((await api.call('GET', '/custom-fields?includeInactive=true', t.lc1!)).json().map((f: { key: string }) => f.key)).not.toContain('father_name'); // only settings managers see retired fields
    expect((await api.call('PUT', `/leads/${lead}/custom-fields`, t.lc1!, { values: { father_name: 'New' } })).statusCode).toBe(400);
    await api.call('PATCH', `/custom-fields/${ids.text}`, t.sa!, { isActive: true });
    expect((await api.call('GET', `/leads/${lead}/custom-fields`, t.lc1!)).json().find((f: { key: string }) => f.key === 'father_name').value).toBe('Kept');
  });

  it('writes definition changes to the audit log', async () => {
    const actions = (await owner.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity = 'custom_field' ORDER BY id`, [fx.tenantId])).rows.map((r) => r.action);
    expect(actions.filter((a) => a === 'custom_field.create')).toHaveLength(4);
    expect(actions).toContain('custom_field.update');
  });
});
