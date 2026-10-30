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
  for (const name of ['admin', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  ids.state = (await owner.query(`INSERT INTO locations (type, name) VALUES ('state', $1) RETURNING id`, [`TestState-${run}`])).rows[0].id;
  for (const [key, name] of [['cityA', `Testville-A-${run}`], ['cityB', `Testville-B-${run}`]] as const) {
    ids[key] = (await owner.query(`INSERT INTO locations (type, name, parent_id) VALUES ('city', $1, $2) RETURNING id`, [name, ids.state])).rows[0].id;
  }
  ids.stream = (await owner.query(`SELECT id FROM streams WHERE tenant_id = $1 AND name = 'Engineering'`, [fx.tenantId])).rows[0].id;

  // A small catalogue: three courses and three institutes that deliver them differently.
  for (const [key, name, level, stream] of [['btech', 'B.Tech', 'UG', ids.stream], ['mba', 'MBA', 'PG', null], ['bba', 'BBA', 'UG', null]] as const) {
    const res = await api.call('POST', '/courses', t.sa!, { name, level, streamId: stream });
    expect(res.statusCode, res.body).toBe(201);
    ids[key] = res.json().id;
  }
  const make = async (key: string, name: string, locationId: string | null, courses: Record<string, unknown>[]) => {
    const res = await api.call('POST', '/colleges', t.sa!, { name, locationId, courses });
    expect(res.statusCode, res.body).toBe(201);
    ids[key] = res.json().id;
  };
  await make('alpha', 'Alpha University', ids.cityA!, [
    { courseId: ids.btech, deliveryMode: 'regular', cafFee: 1500, annualFee: 180000, durationYears: 4 },
    { courseId: ids.mba, deliveryMode: 'online', cafFee: 2000, annualFee: 120000, durationYears: 2 },
  ]);
  await make('beta', 'Beta Institute', ids.cityB!, [
    { courseId: ids.btech, deliveryMode: 'online', annualFee: 90000, durationYears: 4 },
    { courseId: ids.bba, deliveryMode: 'both', cafFee: 1000, annualFee: 70000, durationYears: 3 },
  ]);
  await make('gamma', 'Gamma College', null, [{ courseId: ids.bba, deliveryMode: 'regular', annualFee: 60000 }]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.query(`DELETE FROM locations WHERE type = 'city' AND name LIKE $1`, [`%${run}`]);
  await owner?.query(`DELETE FROM locations WHERE type = 'state' AND name = $1`, [`TestState-${run}`]);
  await owner?.end();
});

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
let counter = 0;
const phone = () => `9${String(400_000_000 + ++counter).padStart(9, '0')}`;

/** The names of the institutes a request returns, following the pages. */
async function collegeNames(token: string, query: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await api.call('GET', `/colleges?limit=50${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`, token);
    expect(res.statusCode, res.body).toBe(200);
    names.push(...res.json().items.map((c: { name: string }) => c.name));
    cursor = res.json().nextCursor;
    pages++;
  } while (cursor && pages < 20);
  return names;
}

// ================================================================== courses

describe('courses and streams', () => {
  it('are listed for anyone who works with leads, filtered and paged', async () => {
    const all = await api.call('GET', '/courses?limit=2', t.lc1!);
    expect(all.json().items).toHaveLength(2);
    expect(all.json().nextCursor).toEqual(expect.any(String));
    const names = (await api.call('GET', '/courses?limit=50', t.lc1!)).json().items.map((c: { name: string }) => c.name);
    expect(names).toEqual(['B.Tech', 'BBA', 'MBA']);

    expect((await api.call('GET', '/courses?level=PG', t.lc1!)).json().items.map((c: { name: string }) => c.name)).toEqual(['MBA']);
    expect((await api.call('GET', '/courses?q=b.t', t.lc1!)).json().items.map((c: { name: string }) => c.name)).toEqual(['B.Tech']);
    expect((await api.call('GET', `/courses?streamId=${ids.stream}`, t.lc1!)).json().items.map((c: { name: string }) => c.name)).toEqual(['B.Tech']);
    expect((await api.call('GET', '/courses?q=%25', t.lc1!)).json().items).toEqual([]);
    expect((await api.call('GET', '/courses?limit=50', t.sa!)).json().items[0]).toMatchObject({ name: 'B.Tech', level: 'UG', stream: { name: 'Engineering' } });
  });

  it('are changed only by those who manage the lists, and a name is used once', async () => {
    expect((await api.call('POST', '/courses', t.lc1!, { name: 'Law', level: 'UG' })).statusCode).toBe(403);
    expect(errorCode(await api.call('POST', '/courses', t.sa!, { name: 'b.tech', level: 'PG' }))).toBe('COURSE_EXISTS');
    expect(errorCode(await api.call('POST', '/courses', t.sa!, { name: 'Law', level: 'LLB' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('POST', '/courses', t.sa!, { name: 'Law', level: 'UG', streamId: '00000000-0000-4000-8000-000000000000' }))).toBe('REFERENCE_INVALID');

    const law = (await api.call('POST', '/courses', t.sa!, { name: 'Law', level: 'UG' })).json();
    const off = await api.call('PATCH', `/courses/${law.id}`, t.sa!, { isActive: false });
    expect(off.json().isActive).toBe(false);
    expect((await api.call('GET', '/courses?q=law', t.lc1!)).json().items).toEqual([]); // hidden from counsellors
    expect((await api.call('GET', '/courses?q=law', t.sa!)).json().items).toHaveLength(1);
  });

  it('streams can be added once', async () => {
    const made = await api.call('POST', '/streams', t.sa!, { name: 'Management' });
    expect(made.statusCode).toBe(201);
    expect(errorCode(await api.call('POST', '/streams', t.sa!, { name: 'management' }))).toBe('STREAM_EXISTS');
    expect((await api.call('GET', '/streams', t.lc1!)).json().map((s: { name: string }) => s.name)).toEqual(['Engineering', 'Management']);
    expect((await api.call('POST', '/streams', t.lc1!, { name: 'Arts' })).statusCode).toBe(403);
  });
});

describe('places', () => {
  it('can be listed by kind, by state and by name', async () => {
    const cities = await api.call('GET', `/locations?type=city&parentId=${ids.state}`, t.lc1!);
    expect(cities.json().map((c: { name: string }) => c.name).sort()).toEqual([`Testville-A-${run}`, `Testville-B-${run}`]);
    expect(cities.json()[0]).toMatchObject({ type: 'city', state: `TestState-${run}` });
    expect((await api.call('GET', `/locations?q=Testville-A-${run}`, t.lc1!)).json()).toHaveLength(1);
    expect((await api.call('GET', `/locations?type=state&q=TestState-${run}`, t.lc1!)).json()[0]).toMatchObject({ type: 'state', parentId: null });
  });
});

// ================================================================== colleges

describe('institutes', () => {
  it('show their courses with fees, how each is delivered, and where they are', async () => {
    const res = await api.call('GET', `/colleges/${ids.alpha}`, t.lc1!);
    expect(res.json()).toMatchObject({ name: 'Alpha University', pendingReview: false, location: { name: `Testville-A-${run}`, state: `TestState-${run}` } });
    expect(res.json().courses).toEqual([
      expect.objectContaining({ course: expect.objectContaining({ name: 'B.Tech', stream: 'Engineering' }), deliveryMode: 'regular', cafFee: 1500, annualFee: 180000, durationYears: 4 }),
      expect.objectContaining({ course: expect.objectContaining({ name: 'MBA' }), deliveryMode: 'online', cafFee: 2000, annualFee: 120000, durationYears: 2 }),
    ]);
  });

  it('are filtered by how a course is delivered', async () => {
    expect(await collegeNames(t.lc1!, 'mode=online')).toEqual(['Alpha University', 'Beta Institute']);
    expect(await collegeNames(t.lc1!, 'mode=regular')).toEqual(['Alpha University', 'Beta Institute', 'Gamma College']); // Beta delivers BBA both ways
    expect(await collegeNames(t.lc1!, 'mode=any')).toEqual(['Alpha University', 'Beta Institute', 'Gamma College']);
    expect(await collegeNames(t.lc1!, '')).toEqual(['Alpha University', 'Beta Institute', 'Gamma College']);
  });

  it('can be limited to those offering a course, in the way that suits', async () => {
    expect(await collegeNames(t.lc1!, `courseId=${ids.btech}`)).toEqual(['Alpha University', 'Beta Institute']);
    expect(await collegeNames(t.lc1!, `courseId=${ids.btech}&mode=online`)).toEqual(['Beta Institute']);
    expect(await collegeNames(t.lc1!, `courseId=${ids.mba}&mode=regular`)).toEqual([]);
  });

  it('follow the study mode of a lead when the list is opened from a lead', async () => {
    const online = (await api.call('POST', '/leads', t.lc1!, { name: 'Online Student', phone: phone(), sourceId: fx.sourceId('Website'), studyMode: 'online' })).json();
    const regular = (await api.call('POST', '/leads', t.lc1!, { name: 'Regular Student', phone: phone(), sourceId: fx.sourceId('Website'), studyMode: 'regular' })).json();
    const unsure = (await api.call('POST', '/leads', t.lc1!, { name: 'Unsure Student', phone: phone(), sourceId: fx.sourceId('Website') })).json();

    expect(await collegeNames(t.lc1!, `leadId=${online.id}`)).toEqual(['Alpha University', 'Beta Institute']);
    expect(await collegeNames(t.lc1!, `leadId=${regular.id}`)).toEqual(['Alpha University', 'Beta Institute', 'Gamma College']);
    expect(await collegeNames(t.lc1!, `leadId=${unsure.id}`)).toHaveLength(3);
    // The counsellor can clear the filter...
    expect(await collegeNames(t.lc1!, `leadId=${online.id}&mode=any`)).toHaveLength(3);
    // ...and cannot use someone else's lead to look around.
    expect((await api.call('GET', `/colleges?leadId=${online.id}`, t.lc2!)).statusCode).toBe(404);
  });

  it('can be limited to a city, or to a whole state', async () => {
    expect(await collegeNames(t.lc1!, `locationId=${ids.cityA}`)).toEqual(['Alpha University']);
    expect(await collegeNames(t.lc1!, `locationId=${ids.state}`)).toEqual(['Alpha University', 'Beta Institute']);
  });

  it('can be searched by name, safely', async () => {
    expect(await collegeNames(t.lc1!, 'q=beta')).toEqual(['Beta Institute']);
    expect(await collegeNames(t.lc1!, 'q=%25')).toEqual([]);
  });

  it('page through everything once, in name order', async () => {
    const page1 = await api.call('GET', '/colleges?limit=2', t.lc1!);
    expect(page1.json().items.map((c: { name: string }) => c.name)).toEqual(['Alpha University', 'Beta Institute']);
    const page2 = await api.call('GET', `/colleges?limit=2&cursor=${page1.json().nextCursor}`, t.lc1!);
    expect(page2.json().items.map((c: { name: string }) => c.name)).toEqual(['Gamma College']);
    expect(page2.json().nextCursor).toBeNull();
    expect(errorCode(await api.call('GET', '/colleges?cursor=forged', t.lc1!))).toBe('INVALID_CURSOR');
  });

  it('show only the courses of the requested kind on the detail page', async () => {
    const res = await api.call('GET', `/colleges/${ids.alpha}?mode=online`, t.lc1!);
    expect(res.json().courses.map((c: { course: { name: string } }) => c.course.name)).toEqual(['MBA']);
  });
});

describe('managing institutes', () => {
  it('does not add the same institute twice in the same place, but allows it in another', async () => {
    const dup = await api.call('POST', '/colleges', t.sa!, { name: 'ALPHA university', locationId: ids.cityA });
    expect(dup.statusCode).toBe(409);
    expect(errorCode(dup)).toBe('COLLEGE_EXISTS');
    expect(dup.json().error.details.existingId).toBe(ids.alpha);

    expect((await api.call('POST', '/colleges', t.sa!, { name: 'Alpha University', locationId: ids.cityB })).statusCode).toBe(201);
    expect(errorCode(await api.call('POST', '/colleges', t.sa!, { name: 'gamma college', locationId: null }))).toBe('COLLEGE_EXISTS'); // no place counts as a place
  });

  it('checks what is sent', async () => {
    const bad = async (body: Record<string, unknown>) => api.call('POST', '/colleges', t.sa!, { name: 'Validation College', ...body });
    expect(errorCode(await bad({ courses: [{ courseId: ids.btech, deliveryMode: 'hybrid' }] }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ courses: [{ courseId: ids.btech, deliveryMode: 'online', annualFee: -5 }] }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ courses: [{ deliveryMode: 'online' }] }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ courses: [{ courseId: ids.btech, newCourse: { name: 'X', level: 'UG' }, deliveryMode: 'online' }] }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await bad({ locationId: '00000000-0000-4000-8000-000000000000' }))).toBe('REFERENCE_INVALID');
  });

  it('can be renamed, moved and switched off, and a switched-off one is hidden from counsellors', async () => {
    const made = (await api.call('POST', '/colleges', t.sa!, { name: 'Delta Academy', locationId: ids.cityA })).json();
    const renamed = await api.call('PATCH', `/colleges/${made.id}`, t.sa!, { name: 'Delta Academy of Arts', locationId: ids.cityB });
    expect(renamed.json()).toMatchObject({ name: 'Delta Academy of Arts', location: { name: `Testville-B-${run}` } });
    expect(errorCode(await api.call('PATCH', `/colleges/${made.id}`, t.sa!, { name: 'Beta Institute' }))).toBe('COLLEGE_EXISTS');

    await api.call('PATCH', `/colleges/${made.id}`, t.sa!, { isActive: false });
    expect(await collegeNames(t.lc1!, 'q=delta')).toEqual([]);
    expect((await api.call('GET', `/colleges/${made.id}`, t.lc1!)).statusCode).toBe(404);
    expect(await collegeNames(t.sa!, 'q=delta')).toEqual(['Delta Academy of Arts']);
    expect((await api.call('PATCH', `/colleges/${made.id}`, t.lc1!, { name: 'Hack' })).statusCode).toBe(403);
  });

  it('can change what an institute offers: add, re-price, switch off and remove', async () => {
    const made = (await api.call('POST', '/colleges', t.sa!, { name: 'Epsilon Tech', locationId: ids.cityA })).json();
    expect(made.courses).toEqual([]);
    expect(await collegeNames(t.lc1!, 'mode=online&q=epsilon')).toEqual([]); // offers nothing yet

    const added = await api.call('PUT', `/colleges/${made.id}/courses/${ids.btech}`, t.sa!, { deliveryMode: 'online', cafFee: 500, annualFee: 80000, durationYears: 4 });
    expect(added.json().courses).toHaveLength(1);
    expect(await collegeNames(t.lc1!, 'mode=online&q=epsilon')).toEqual(['Epsilon Tech']);

    const repriced = await api.call('PUT', `/colleges/${made.id}/courses/${ids.btech}`, t.sa!, { deliveryMode: 'regular', annualFee: 95000 });
    expect(repriced.json().courses[0]).toMatchObject({ deliveryMode: 'regular', annualFee: 95000, cafFee: null, isActive: true });
    expect(await collegeNames(t.lc1!, 'mode=online&q=epsilon')).toEqual([]);

    await api.call('PUT', `/colleges/${made.id}/courses/${ids.btech}`, t.sa!, { deliveryMode: 'regular', isActive: false });
    expect(await collegeNames(t.lc1!, 'mode=regular&q=epsilon')).toEqual([]);

    expect((await api.call('DELETE', `/colleges/${made.id}/courses/${ids.btech}`, t.sa!)).json().courses).toEqual([]);
    expect((await api.call('DELETE', `/colleges/${made.id}/courses/${ids.btech}`, t.sa!)).statusCode).toBe(404);
    expect((await api.call('PUT', `/colleges/${made.id}/courses/${ids.btech}`, t.lc1!, { deliveryMode: 'online' })).statusCode).toBe(403);
  });
});

// ====================================================== added by hand, reviewed

describe('an institute a counsellor adds by hand', () => {
  let manual: { id: string };

  it('is usable at once but flagged for review, and reuses a course the company already has', async () => {
    const coursesBefore = (await api.call('GET', '/courses?limit=100', t.sa!)).json().items.length;
    const res = await api.call('POST', '/colleges', t.lc1!, {
      name: 'Zeta Online University',
      courses: [
        { newCourse: { name: 'b.tech', level: 'UG' }, deliveryMode: 'online', annualFee: 50000 },
        { newCourse: { name: 'Data Science', level: 'PG', streamId: ids.stream }, deliveryMode: 'online', annualFee: 150000, durationYears: 2 },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    manual = res.json();
    expect(manual).toMatchObject({ pendingReview: true });
    expect(res.json().courses.map((c: { course: { name: string } }) => c.course.name).sort()).toEqual(['B.Tech', 'Data Science']);

    const coursesAfter = (await api.call('GET', '/courses?limit=100', t.sa!)).json().items.length;
    expect(coursesAfter).toBe(coursesBefore + 1); // only Data Science is new
    expect(await collegeNames(t.lc2!, 'mode=online&q=zeta')).toEqual(['Zeta Online University']);
    expect((await api.call('GET', '/colleges?mode=online&q=zeta', t.lc2!)).json().items[0].pendingReview).toBe(true);
  });

  it('is waiting in the review list for those who review, and for them alone', async () => {
    expect(errorCode(await api.call('GET', '/colleges?pendingReview=true', t.lc1!))).toBe('FORBIDDEN');
    const waiting = await api.call('GET', '/colleges?pendingReview=true', t.admin!);
    expect(waiting.json().items.map((c: { id: string }) => c.id)).toEqual([manual.id]);
    expect((await api.call('POST', `/colleges/${manual.id}/review`, t.lc1!, { decision: 'approved' })).statusCode).toBe(403);
  });

  it('is cleared once an Admin approves it', async () => {
    const res = await api.call('POST', `/colleges/${manual.id}/review`, t.admin!, { decision: 'approved' });
    expect(res.json().pendingReview).toBe(false);
    expect((await api.call('GET', '/colleges?pendingReview=true', t.admin!)).json().items).toEqual([]);
    expect(errorCode(await api.call('POST', `/colleges/${manual.id}/review`, t.admin!, { decision: 'approved' }))).toBe('NOT_PENDING');
    expect(await collegeNames(t.lc2!, 'q=zeta')).toEqual(['Zeta Online University']);
  });

  it('disappears for counsellors if an Admin turns it down', async () => {
    const res = await api.call('POST', '/colleges', t.lc1!, { name: 'Dubious Institute', courses: [{ newCourse: { name: 'Dubious Course', level: 'UG' }, deliveryMode: 'online' }] });
    const id = res.json().id;
    const rejected = await api.call('POST', `/colleges/${id}/review`, t.admin!, { decision: 'rejected' });
    expect(rejected.json()).toMatchObject({ pendingReview: false, isActive: false });
    expect(await collegeNames(t.lc1!, 'q=dubious')).toEqual([]);
    expect(await collegeNames(t.sa!, 'q=dubious')).toEqual(['Dubious Institute']);
  });

  it('cannot be added by someone with no permission to add institutes', async () => {
    const roleId = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Viewer', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code IN ('master.read', 'lead.read')`, [fx.tenantId, roleId]);
    await fx.addUser({ name: 'viewer', roleId });
    const viewer = await api.signIn('viewer');
    expect((await api.call('POST', '/colleges', viewer, { name: 'Viewer College' })).statusCode).toBe(403);
    expect((await api.call('GET', '/colleges', viewer)).statusCode).toBe(200);
  });
});
