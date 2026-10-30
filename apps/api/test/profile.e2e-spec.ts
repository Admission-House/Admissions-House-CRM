import { randomUUID } from 'node:crypto';
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
const run = randomUUID().slice(0, 8);
const ids: Record<string, string> = {};

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  const state = (await owner.query(`INSERT INTO locations (type, name) VALUES ('state', $1) RETURNING id`, [`TestState-${run}`])).rows[0].id;
  ids.state = state;
  for (const [key, name] of [['cityA', `Testville-A-${run}`], ['cityB', `Testville-B-${run}`]] as const) {
    ids[key] = (await owner.query(`INSERT INTO locations (type, name, parent_id) VALUES ('city', $1, $2) RETURNING id`, [name, state])).rows[0].id;
  }
  ids.stream = (await owner.query(`SELECT id FROM streams WHERE tenant_id = $1 AND name = 'Engineering'`, [fx.tenantId])).rows[0].id;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.query(`DELETE FROM locations WHERE type = 'city' AND name LIKE $1`, [`%${run}`]);
  await owner?.query(`DELETE FROM locations WHERE type = 'state' AND name = $1`, [`TestState-${run}`]);
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(500_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

async function lead(token: string, over: Record<string, unknown> = {}) {
  const res = await api.call('POST', '/leads', token, { name: 'Profile Lead', phone: phone(), sourceId: fx.sourceId('Website'), ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; leadNo: string };
}
const patch = (token: string, id: string, body: Record<string, unknown>) => api.call('PATCH', `/leads/${id}/profile`, token, body);
const read = async (token: string, id: string) => (await api.call('GET', `/leads/${id}/profile`, token)).json();
const history = async (token: string, id: string) =>
  (await api.call('GET', `/leads/${id}/activities?limit=100`, token)).json().items.filter((a: { field: string | null }) => a.field?.startsWith('profile.')) as {
    field: string; oldValue: string | null; newValue: string | null; remark: string | null;
  }[];

// ================================================================== reading

describe('a new lead\'s profile', () => {
  it('is empty, and shows the lead\'s study mode', async () => {
    const l = await lead(t.lc1!, { studyMode: 'online' });
    expect(await read(t.lc1!, l.id)).toEqual({
      personal: { alternateEmail: null, dateOfBirth: null, gender: null, category: null, currentLocation: null, extraPhones: [] },
      preferences: { studyMode: 'online', preferredYear: null, preferredLevel: null, preferredStream: null, budgetMin: null, budgetMax: null, loanRequired: null, preferredLocations: [] },
      guardians: [], education: [], exams: [], updatedAt: null, updatedBy: null,
    });
  });
});

// ================================================================== personal

describe('personal details', () => {
  it('are saved, shown with the state of the city, and recorded in the history', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      personal: { alternateEmail: 'Parent@Example.com', dateOfBirth: '2006-04-12', gender: 'female', category: 'obc', currentLocationId: ids.cityA },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().personal).toMatchObject({
      alternateEmail: 'parent@example.com', dateOfBirth: '2006-04-12', gender: 'female', category: 'obc',
      currentLocation: { id: ids.cityA, type: 'city', state: `TestState-${run}` },
    });
    expect(res.json().updatedBy).toBe('lc1');

    const entries = await history(t.lc1!, l.id);
    expect(entries.map((e) => e.field).sort()).toEqual(['profile.alternate_email', 'profile.category', 'profile.current_location_id', 'profile.date_of_birth', 'profile.gender']);
    expect(entries.find((e) => e.field === 'profile.gender')).toMatchObject({ oldValue: null, newValue: 'female' });
  });

  it('keep what was not sent, and record nothing when nothing changed', async () => {
    const l = await lead(t.lc1!);
    await patch(t.lc1!, l.id, { personal: { gender: 'male', category: 'general' } });
    const before = (await history(t.lc1!, l.id)).length;

    const res = await patch(t.lc1!, l.id, { personal: { category: 'general', alternateEmail: 'a@b.co' } });
    expect(res.json().personal).toMatchObject({ gender: 'male', category: 'general', alternateEmail: 'a@b.co' });
    expect((await history(t.lc1!, l.id)).length).toBe(before + 1); // only the email
  });

  it('can be cleared', async () => {
    const l = await lead(t.lc1!);
    await patch(t.lc1!, l.id, { personal: { gender: 'male', currentLocationId: ids.cityA } });
    const res = await patch(t.lc1!, l.id, { personal: { gender: null, currentLocationId: null } });
    expect(res.json().personal).toMatchObject({ gender: null, currentLocation: null });
  });

  it.each([
    ['a date of birth in the future', { dateOfBirth: '2999-01-01' }],
    ['an impossible date', { dateOfBirth: '2006-02-31' }],
    ['a year of birth that cannot be right', { dateOfBirth: '1800-01-01' }],
    ['a gender that is not in the list', { gender: 'robot' }],
    ['an email that is not an email', { alternateEmail: 'nope' }],
  ])('refuses %s', async (_n, personal) => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, { personal });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });

  it('refuses a city that does not exist', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, { personal: { currentLocationId: '00000000-0000-4000-8000-000000000000' } });
    expect(errorCode(res)).toBe('REFERENCE_INVALID');
  });

  describe('extra phone numbers', () => {
    it('are normalised, replaced as a list, and removed by sending an empty one', async () => {
      const l = await lead(t.lc1!);
      const first = await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: '+91 98765 55555', label: 'parent' }, { phone: '09876566666' }] } });
      expect(first.json().personal.extraPhones).toEqual([
        { phone: '919876555555', label: 'parent' }, { phone: '919876566666', label: 'alternate' },
      ]);
      const second = await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: '9876577777', label: 'whatsapp' }] } });
      expect(second.json().personal.extraPhones).toEqual([{ phone: '919876577777', label: 'whatsapp' }]);
      const cleared = await patch(t.lc1!, l.id, { personal: { extraPhones: [] } });
      expect(cleared.json().personal.extraPhones).toEqual([]);
    });

    it('cannot repeat the main number, or be listed twice', async () => {
      const main = phone();
      const l = await lead(t.lc1!, { phone: main });
      expect(errorCode(await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: main }] } }))).toBe('PHONE_IS_PRIMARY');
      expect((await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: '9876588888' }, { phone: '+91 98765 88888' }] } })).statusCode).toBe(400);
    });

    it('cannot be a number that belongs to another lead, so one person never appears as two leads', async () => {
      const other = await lead(t.lc1!, { phone: '9876599999' });
      const l = await lead(t.lc1!);
      const clash = await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: '98765 99999' }] } });
      expect(clash.statusCode).toBe(409);
      expect(errorCode(clash)).toBe('PHONE_IN_USE');
      expect(clash.json().error.details.leadNo).toBe(other.leadNo);

      // Nor a number another lead keeps as an extra one.
      await patch(t.lc1!, other.id, { personal: { extraPhones: [{ phone: '9876500001' }] } });
      expect(errorCode(await patch(t.lc1!, l.id, { personal: { extraPhones: [{ phone: '9876500001' }] } }))).toBe('PHONE_IN_USE');
    });
  });
});

// ================================================================ preferences

describe('preferences', () => {
  it('are saved with the stream and the preferred places, and the list of places can be replaced', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      preferences: { preferredYear: 2027, preferredLevel: 'UG', preferredStreamId: ids.stream, budgetMin: 100000, budgetMax: 400000, loanRequired: true, preferredLocationIds: [ids.cityA, ids.state, ids.cityA] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().preferences).toMatchObject({
      preferredYear: 2027, preferredLevel: 'UG', preferredStream: { name: 'Engineering' }, budgetMin: 100000, budgetMax: 400000, loanRequired: true,
    });
    expect(res.json().preferences.preferredLocations.map((p: { id: string }) => p.id).sort()).toEqual([ids.cityA, ids.state].sort());

    const replaced = await patch(t.lc1!, l.id, { preferences: { preferredLocationIds: [ids.cityB] } });
    expect(replaced.json().preferences.preferredLocations.map((p: { id: string }) => p.id)).toEqual([ids.cityB]);
    expect(replaced.json().preferences.preferredYear).toBe(2027); // untouched
  });

  it('keep the highest budget at or above the lowest, even when only one of them is sent', async () => {
    const l = await lead(t.lc1!);
    await patch(t.lc1!, l.id, { preferences: { budgetMin: 200000, budgetMax: 500000 } });
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { budgetMax: 100000 } }))).toBe('BUDGET_INVALID');
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { budgetMin: 900000 } }))).toBe('BUDGET_INVALID');
    expect((await patch(t.lc1!, l.id, { preferences: { budgetMin: 300000 } })).statusCode).toBe(200);
    expect((await read(t.lc1!, l.id)).preferences.budgetMax).toBe(500000);
  });

  it('refuse a stream or place that does not exist, and a year or level that makes no sense', async () => {
    const l = await lead(t.lc1!);
    const none = '00000000-0000-4000-8000-000000000000';
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { preferredStreamId: none } }))).toBe('REFERENCE_INVALID');
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { preferredLocationIds: [ids.cityA, none] } }))).toBe('REFERENCE_INVALID');
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { preferredYear: 1999 } }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await patch(t.lc1!, l.id, { preferences: { preferredLevel: 'PhD' } }))).toBe('VALIDATION_FAILED');
    expect(await read(t.lc1!, l.id)).toMatchObject({ preferences: { preferredLocations: [], preferredYear: null } }); // nothing half-saved
  });
});

// ============================================================== guardians etc.

describe('guardians', () => {
  it('are replaced as a list with their phone numbers normalised', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      guardians: [{ relation: 'mother', name: 'Sunita Sharma', phone: '9876511223', occupation: 'Teacher' }, { relation: 'father', name: 'Rakesh Sharma' }],
    });
    expect(res.json().guardians).toEqual([
      { relation: 'father', name: 'Rakesh Sharma', phone: null, occupation: null },
      { relation: 'mother', name: 'Sunita Sharma', phone: '919876511223', occupation: 'Teacher' },
    ]);
    expect((await patch(t.lc1!, l.id, { guardians: [] })).json().guardians).toEqual([]);
  });

  it('refuse the same relation twice and a phone that is not a phone', async () => {
    const l = await lead(t.lc1!);
    expect((await patch(t.lc1!, l.id, { guardians: [{ relation: 'father' }, { relation: 'father' }] })).statusCode).toBe(400);
    expect((await patch(t.lc1!, l.id, { guardians: [{ relation: 'mother', phone: '123' }] })).statusCode).toBe(400);
  });
});

describe('education', () => {
  it('is kept in school-to-college order', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      education: [
        { level: 'graduation', marksType: 'cgpa', marks: 8.4, institution: 'XYZ College', passingYear: 2025 },
        { level: '12th', marksType: 'percentage', marks: 88.5, institution: 'City School', board: 'CBSE', passingYear: 2021 },
        { level: '10th', marksType: 'percentage', marks: 91, board: 'CBSE' },
      ],
    });
    expect(res.json().education.map((e: { level: string }) => e.level)).toEqual(['10th', '12th', 'graduation']);
    expect(res.json().education[1]).toEqual({ level: '12th', marksType: 'percentage', marks: 88.5, institution: 'City School', board: 'CBSE', passingYear: 2021 });
  });

  it.each([
    ['marks without saying what kind', [{ level: '10th', marks: 80 }]],
    ['a percentage over 100', [{ level: '10th', marksType: 'percentage', marks: 101 }]],
    ['a CGPA over 10', [{ level: 'graduation', marksType: 'cgpa', marks: 11 }]],
    ['the same level twice', [{ level: '10th' }, { level: '10th' }]],
    ['a level that is not in the list', [{ level: 'kindergarten' }]],
  ])('refuses %s', async (_n, education) => {
    const l = await lead(t.lc1!);
    expect((await patch(t.lc1!, l.id, { education })).statusCode).toBe(400);
  });
});

describe('entrance exams', () => {
  it('are listed with the newest year first', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      exams: [{ examName: 'JEE Main', marksType: 'percentile', score: 94.2, examYear: 2025 }, { examName: 'JEE Main', marksType: 'rank', score: 18000, examYear: 2026 }, { examName: 'CUET', marksType: 'score', score: 640, examYear: 2026 }],
    });
    expect(res.json().exams.map((e: { examName: string; examYear: number }) => `${e.examName} ${e.examYear}`)).toEqual(['CUET 2026', 'JEE Main 2026', 'JEE Main 2025']);
  });

  it('refuse the same exam in the same year twice, and a percentile over 100', async () => {
    const l = await lead(t.lc1!);
    expect((await patch(t.lc1!, l.id, { exams: [{ examName: 'CUET', examYear: 2026 }, { examName: 'cuet', examYear: 2026 }] })).statusCode).toBe(400);
    expect((await patch(t.lc1!, l.id, { exams: [{ examName: 'JEE', marksType: 'percentile', score: 120, examYear: 2026 }] })).statusCode).toBe(400);
  });
});

describe('sections', () => {
  it('are independent: changing one leaves the others alone', async () => {
    const l = await lead(t.lc1!);
    await patch(t.lc1!, l.id, {
      guardians: [{ relation: 'father', name: 'Keep Me' }],
      education: [{ level: '10th', marksType: 'percentage', marks: 70 }],
      exams: [{ examName: 'CUET', examYear: 2026 }],
    });
    await patch(t.lc1!, l.id, { exams: [] });
    const now = await read(t.lc1!, l.id);
    expect(now.exams).toEqual([]);
    expect(now.guardians).toHaveLength(1);
    expect(now.education).toHaveLength(1);
  });

  it('refuse a request that changes nothing', async () => {
    const l = await lead(t.lc1!);
    expect(errorCode(await patch(t.lc1!, l.id, {}))).toBe('VALIDATION_FAILED');
    expect(errorCode(await patch(t.lc1!, l.id, { hobbies: ['chess'] }))).toBe('VALIDATION_FAILED');
  });

  it('save as a whole: one bad section stops the others from being saved', async () => {
    const l = await lead(t.lc1!);
    const res = await patch(t.lc1!, l.id, {
      guardians: [{ relation: 'father', name: 'Not Saved' }],
      preferences: { preferredStreamId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect((await read(t.lc1!, l.id)).guardians).toEqual([]);
  });

  it('survive several people saving at once, one after another', async () => {
    const l = await lead(t.lc1!);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_v, i) => patch(t.lc1!, l.id, { exams: [{ examName: `Exam ${i}`, examYear: 2026 }], education: [{ level: '12th', marksType: 'percentage', marks: 60 + i }] })),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const now = await read(t.lc1!, l.id);
    expect(now.exams).toHaveLength(1);
    expect(now.education).toHaveLength(1);
  });
});

// =============================================================== who may use it

describe('who can read and change a profile', () => {
  it('follows who can see the lead', async () => {
    const l = await lead(t.lc1!);
    expect((await api.call('GET', `/leads/${l.id}/profile`, t.lc2!)).statusCode).toBe(404);
    expect((await patch(t.lc2!, l.id, { personal: { gender: 'male' } })).statusCode).toBe(404);
    expect((await api.call('GET', `/leads/${l.id}/profile`, t.admin2!)).statusCode).toBe(404);
    expect((await patch(t.admin!, l.id, { personal: { gender: 'male' } })).statusCode).toBe(200);
    expect((await api.call('GET', `/leads/${l.id}/profile`, t.sa!)).statusCode).toBe(200);
  });

  it('lets someone who may only read look but not change', async () => {
    const roleId = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Reader', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'lead.read'`, [fx.tenantId, roleId]);
    await fx.addUser({ name: 'reader', roleId });
    const reader = await api.signIn('reader');
    const l = await lead(t.lc1!);
    expect((await api.call('GET', `/leads/${l.id}/profile`, reader)).statusCode).toBe(200);
    expect((await patch(reader, l.id, { personal: { gender: 'male' } })).statusCode).toBe(403);
  });

  it('is gone with the lead', async () => {
    const l = await lead(t.lc1!);
    await api.call('DELETE', `/leads/${l.id}`, t.sa!);
    expect((await api.call('GET', `/leads/${l.id}/profile`, t.sa!)).statusCode).toBe(404);
  });
});
