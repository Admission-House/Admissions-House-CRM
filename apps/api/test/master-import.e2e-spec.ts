import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart } from './helpers/multipart.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const run = randomUUID().slice(0, 8);
const CITY = `Testville-${run}`;
const TWIN = `Testville-twin-${run}`;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'lc1']) t[name] = await api.signIn(name, { office: true });

  const [s1, s2] = [`TestState-1-${run}`, `TestState-2-${run}`];
  const ids: string[] = [];
  for (const s of [s1, s2]) ids.push((await owner.query(`INSERT INTO locations (type, name) VALUES ('state', $1) RETURNING id`, [s])).rows[0].id);
  await owner.query(`INSERT INTO locations (type, name, parent_id) VALUES ('city', $1, $2)`, [CITY, ids[0]]);
  for (const id of ids) await owner.query(`INSERT INTO locations (type, name, parent_id) VALUES ('city', $1, $2)`, [TWIN, id]);
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.query(`DELETE FROM locations WHERE type = 'city' AND name LIKE $1`, [`%${run}`]);
  await owner?.query(`DELETE FROM locations WHERE type = 'state' AND name LIKE $1`, [`%${run}`]);
  await owner?.end();
});

const csv = (...lines: string[]) => Buffer.from(lines.join('\n') + '\n', 'utf8');
function send(token: string, path: string, data: Buffer, fields: Record<string, string> = {}) {
  const { payload, contentType } = multipart(fields, [{ filename: 'colleges.csv', data }]);
  return app.inject({ method: 'POST', url: `/api/v1/masters/import${path}`, payload, headers: { authorization: `Bearer ${token}`, 'content-type': contentType } });
}
const count = async (table: string) => Number((await owner.query(`SELECT count(*) FROM ${table} WHERE tenant_id = $1`, [fx.tenantId])).rows[0].count);
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

const HEADER = 'College,City,State,Course,Level,Stream,Mode,CAF Fee,Annual Fee,Duration';

describe('importing colleges, courses and fees', () => {
  it('previews without saving anything', async () => {
    const before = [await count('colleges'), await count('courses'), await count('college_courses')];
    const res = await send(
      t.sa!, '/preview',
      csv(HEADER, `Orion University,${CITY},,B.Tech,UG,Engineering,regular,1500,"1,80,000",4`, `Orion University,${CITY},,MBA,PG,,online,2000,120000,2`),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ applied: false, rows: 2, colleges: { new: 1, existing: 0 }, courses: { new: 2, existing: 0 }, offers: { new: 2, updated: 0 }, problems: [], missing: [] });
    expect([await count('colleges'), await count('courses'), await count('college_courses')]).toEqual(before);
  });

  it('adds colleges, courses and fees, and finds them again on a second run', async () => {
    const data = csv(
      HEADER,
      `Orion University,${CITY},,B.Tech,UG,Engineering,regular,1500,"₹1,80,000",4 years`,
      `Orion University,${CITY},,MBA,PG,,Online,2000,120000,2`,
      `Nova College,,,BBA,UG,,both,,70000,3`,
    );
    const first = await send(t.sa!, '', data);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ applied: true, colleges: { new: 2 }, courses: { new: 3 }, offers: { new: 3, updated: 0 }, problems: [] });

    const offer = (await owner.query(
      `SELECT cc.delivery_mode, cc.caf_fee::float AS caf, cc.annual_fee::float AS annual, cc.duration_years::float AS years, co.level, co.stream_id, c.is_manual, c.reviewed_by, c.location_id
       FROM college_courses cc JOIN colleges c ON c.id = cc.college_id JOIN courses co ON co.id = cc.course_id
       WHERE cc.tenant_id = $1 AND c.name = 'Orion University' AND co.name = 'B.Tech'`, [fx.tenantId])).rows[0];
    expect(offer).toMatchObject({ delivery_mode: 'regular', caf: 1500, annual: 180000, years: 4, level: 'UG', is_manual: false, reviewed_by: fx.user('super').id });
    expect(offer.stream_id).not.toBeNull();
    expect(offer.location_id).not.toBeNull();

    const again = await send(t.sa!, '', csv(HEADER, `orion university,${CITY},,b.tech,,,online,1500,200000,4`));
    expect(again.json()).toMatchObject({ colleges: { new: 0, existing: 1 }, courses: { new: 0, existing: 1 }, offers: { new: 0, updated: 1 }, problems: [] });
    const changed = (await owner.query(`SELECT delivery_mode, annual_fee::float AS annual FROM college_courses cc JOIN courses co ON co.id = cc.course_id WHERE cc.tenant_id = $1 AND co.name = 'B.Tech'`, [fx.tenantId])).rows[0];
    expect(changed).toEqual({ delivery_mode: 'online', annual: 200000 });
    expect(await count('colleges')).toBe(2); // names match whatever the capitalisation
  });

  it('reports rows it cannot place and still adds the rest', async () => {
    const res = await send(
      t.sa!, '',
      csv(
        HEADER,
        `Good College,${CITY},,Diploma in IT,Diploma,,regular,,50000,1`,
        `Lost College,Nowhere-${run},,BBA,UG,,regular,,,`,
        `Twin College,${TWIN},,BBA,UG,,regular,,,`,
        `Streamless,${CITY},,New Course X,UG,No Such Stream,regular,,,`,
        `Wrong Level,${CITY},,BBA,PG,,regular,,,`,
        `No Level,${CITY},,Brand New Course,,,regular,,,`,
        `Dup College,,,BCA,UG,,regular,,,`,
        `Dup College,,,BCA,UG,,online,,,`,
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.offers.new).toBe(2); // Good College and the first Dup College row
    const byRow = Object.fromEntries(body.problems.map((p: { row: number; problem: string }) => [p.row, p.problem]));
    expect(byRow[3]).toContain('is not in the list of places');
    expect(byRow[4]).toContain('more than one state');
    expect(byRow[5]).toContain('is not in the list of streams');
    expect(byRow[6]).toContain('already in the list as UG');
    expect(byRow[7]).toContain('New course');
    expect(byRow[9]).toContain('more than once');
    expect(Object.keys(byRow)).toHaveLength(6);
    expect(Number((await owner.query(`SELECT count(*) FROM courses WHERE tenant_id = $1 AND name IN ('New Course X', 'Brand New Course')`, [fx.tenantId])).rows[0].count)).toBe(0);
  });

  it('uses a state column to tell two cities of the same name apart', async () => {
    const res = await send(t.sa!, '', csv(HEADER, `Twin College,${TWIN},TestState-2-${run},BBA,UG,,regular,,,`));
    expect(res.json()).toMatchObject({ problems: [], offers: { new: 1 } });
    const place = (await owner.query(`SELECT p.name FROM colleges c JOIN locations l ON l.id = c.location_id JOIN locations p ON p.id = l.parent_id WHERE c.tenant_id = $1 AND c.name = 'Twin College'`, [fx.tenantId])).rows[0];
    expect(place.name).toBe(`TestState-2-${run}`);
  });

  it('asks which column is which when the file does not say, and accepts the answer', async () => {
    const data = csv('Uni,Programme,Type', 'Mapped College,Mapped Course,online');
    const res = await send(t.sa!, '', data);
    expect(res.statusCode).toBe(422);
    expect(errorCode(res)).toBe('MAPPING_INCOMPLETE');
    expect(res.json().error.details.missing).toEqual(['college', 'mode']);
    const fixed = await send(t.sa!, '', data, { mapping: JSON.stringify({ college: 'Uni', mode: 'Type' }) });
    expect(fixed.json()).toMatchObject({ offers: { new: 0 }, problems: [{ row: 2, problem: expect.stringContaining('New course') }] });
  });

  it('writes the audit log, and needs the permission to manage lists', async () => {
    const entry = (await owner.query(`SELECT actor_id, after FROM audit_logs WHERE tenant_id = $1 AND action = 'master.import' ORDER BY id DESC LIMIT 1`, [fx.tenantId])).rows[0];
    expect(entry.actor_id).toBe(fx.user('super').id);
    expect(entry.after).toHaveProperty('offers');
    expect((await send(t.admin!, '', csv(HEADER))).statusCode).toBe(403);
    expect((await send(t.lc1!, '/preview', csv(HEADER))).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/masters/import/preview' })).statusCode).toBe(401);
  });
});
