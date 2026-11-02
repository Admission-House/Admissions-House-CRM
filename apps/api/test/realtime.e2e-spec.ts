import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import WebSocket from 'ws';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let url: string;
const open: WebSocket[] = [];

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  // A long cache for the queue counts on purpose: a live change must show at once anyway.
  app = await startApp({ REALTIME_ENABLED: 'true', REALTIME_RECHECK_SEC: '1', LOGIN_IP_MAX_ATTEMPTS: '500', QUEUE_COUNT_CACHE_SEC: '30' });
  await app.listen(0, '127.0.0.1');
  url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/ws`;
  api = makeClient(app, fx);
  // The listener connects to the database in the background; give it a moment before the first change.
  await sleep(500);
});

afterAll(async () => {
  for (const ws of open) ws.terminate();
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

interface Conn { ws: WebSocket; events: { type: string; topics?: string[] }[]; code: () => number | undefined; refused: () => number | undefined }

/** Opens a connection and records what comes in and how it ends. */
function connect(headers: Record<string, string> = {}, path = '/api/v1/ws'): Conn {
  let closeCode: number | undefined;
  let refusedStatus: number | undefined;
  const ws = new WebSocket(url.replace('/api/v1/ws', path), { headers });
  open.push(ws);
  const events: Conn['events'] = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString()) as Conn['events'][number]));
  ws.on('close', (code) => { closeCode = code; });
  ws.on('unexpected-response', (_req, res) => { refusedStatus = res.statusCode; });
  ws.on('error', () => undefined);
  return { ws, events, code: () => closeCode, refused: () => refusedStatus };
}

/** A connection that has signed in. */
async function signedIn(token: string): Promise<Conn> {
  const c = connect();
  await until(() => c.ws.readyState === WebSocket.OPEN);
  c.ws.send(JSON.stringify({ type: 'auth', token }));
  await until(() => c.events.some((e) => e.type === 'ready'));
  return c;
}

const topics = (c: Conn) => c.events.filter((e) => e.type === 'event').flatMap((e) => e.topics ?? []);
const idOf = (name: string) => fx.user(name).id;
const notify = (name: string) =>
  owner.query(`INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1, $2, 'lead_new', '{"event":"lead_assigned"}')`, [fx.tenantId, idOf(name)]);

describe('signing in on the connection', () => {
  it('closes a connection whose first message is not a sign-in, or not JSON', async () => {
    const a = connect();
    await until(() => a.ws.readyState === WebSocket.OPEN);
    a.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => a.code() !== undefined);
    expect(a.code()).toBe(4400);

    const b = connect();
    await until(() => b.ws.readyState === WebSocket.OPEN);
    b.ws.send('hello');
    await until(() => b.code() !== undefined);
    expect(b.code()).toBe(4400);
  });

  it('closes a connection with a token that is wrong, and says to sign in again', async () => {
    const c = connect();
    await until(() => c.ws.readyState === WebSocket.OPEN);
    c.ws.send(JSON.stringify({ type: 'auth', token: 'aaa.bbb.ccc' }));
    await until(() => c.code() !== undefined);
    expect(c.code()).toBe(4401);
  });

  it('says ready for a good token, and answers a ping', async () => {
    const c = await signedIn(await api.signIn('super'));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => c.events.some((e) => e.type === 'pong'));
  });

  it('does not count the connection as activity, so it cannot keep an idle session open', async () => {
    const token = await api.signIn('idle');
    const before = (await owner.query(`SELECT last_active_at FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL`, [idOf('idle')])).rows[0].last_active_at as Date;
    await sleep(1100);
    await signedIn(token);
    const after = (await owner.query(`SELECT last_active_at FROM user_sessions WHERE user_id = $1 AND ended_at IS NULL`, [idOf('idle')])).rows[0].last_active_at as Date;
    expect(after.getTime()).toBe(before.getTime());
  });
});

describe('who is let in', () => {
  it('refuses a browser from an address that is not on the list, and lets the listed one in', async () => {
    const bad = connect({ origin: 'http://evil.example' });
    await until(() => bad.refused() !== undefined);
    expect(bad.refused()).toBe(403);

    const good = connect({ origin: 'http://localhost:3000' });
    await until(() => good.ws.readyState === WebSocket.OPEN);
  });

  it('has no other address', async () => {
    const c = connect({}, '/api/v1/elsewhere');
    await until(() => c.ws.readyState === WebSocket.CLOSED);
    expect(c.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('closes a connection that sends a large message', async () => {
    const c = await signedIn(await api.signIn('refresh'));
    c.ws.send('x'.repeat(4000));
    await until(() => c.code() !== undefined);
    expect(c.code()).toBe(1009);
  });

  it('keeps five connections per person and closes the oldest beyond that', async () => {
    const token = await api.signIn('reuse');
    const first = await signedIn(token);
    const rest: Conn[] = [];
    for (let i = 0; i < 5; i++) rest.push(await signedIn(token));
    await until(() => first.code() !== undefined);
    expect(first.code()).toBe(4409);
    expect(rest.every((c) => c.code() === undefined)).toBe(true);
  });
});

describe('live hints', () => {
  it('tells a person about their own new notification and nobody else', async () => {
    const mine = await signedIn(await api.signIn('lc1', { office: true }));
    const theirs = await signedIn(await api.signIn('lc2', { office: true }));
    await notify('lc1');
    await until(() => topics(mine).includes('notification'));
    await sleep(800);
    expect(topics(theirs)).not.toContain('notification');
    // The hint carries no data, only the topic.
    expect(mine.events.find((e) => e.type === 'event')).toEqual({ type: 'event', topics: ['notification'] });
  });

  it('tells the people who oversee the team when someone signs in, and not a counsellor', async () => {
    const boss = await signedIn(await api.signIn('super'));
    const counsellor = await signedIn(await api.signIn('lc3', { office: true }));
    boss.events.length = 0;
    counsellor.events.length = 0;
    await api.signIn('logout'); // a new session: someone has come online
    await until(() => topics(boss).includes('team'));
    await sleep(800);
    expect(topics(counsellor)).not.toContain('team');
  });

  it('tells the people who oversee the team when a lead is added', async () => {
    const boss = await signedIn(await api.signIn('admin', { office: true }));
    const token = await api.signIn('super');
    boss.events.length = 0;
    const res = await api.call('POST', '/leads', token, { name: 'Live Lead', phone: '9876500077', sourceId: fx.sourceId('Website') });
    expect(res.statusCode, res.body).toBe(201);
    await until(() => topics(boss).includes('lead'));
  });

  it('drops the cached queue counts the moment a lead changes, so the count the screen then asks for is current', async () => {
    const token = await api.signIn('super');
    const boss = await signedIn(token);
    const total = async () => (await api.call('GET', '/leads/queues', token)).json().total as number;
    const before = await total();
    expect(await total()).toBe(before); // now cached for 30 seconds
    boss.events.length = 0;
    const res = await api.call('POST', '/leads', token, { name: 'Counted Lead', phone: '9876500088', sourceId: fx.sourceId('Website') });
    expect(res.statusCode, res.body).toBe(201);
    await until(() => topics(boss).includes('lead'));
    expect(await total()).toBe(before + 1);
  });

  it('sends one message for a burst of changes', async () => {
    const boss = await signedIn(await api.signIn('super'));
    boss.events.length = 0;
    await owner.query('BEGIN');
    for (let i = 0; i < 5; i++) await owner.query(`INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1, $2, 'lead_new', '{}')`, [fx.tenantId, idOf('super')]);
    await owner.query('COMMIT');
    await until(() => topics(boss).includes('notification'));
    await sleep(800);
    expect(boss.events.filter((e) => e.type === 'event')).toHaveLength(1);
  });

  it('sends nothing for a change that was rolled back', async () => {
    const boss = await signedIn(await api.signIn('super'));
    boss.events.length = 0;
    await owner.query('BEGIN');
    await owner.query(`INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1, $2, 'lead_new', '{}')`, [fx.tenantId, idOf('super')]);
    await owner.query('ROLLBACK');
    await sleep(1000);
    expect(topics(boss)).not.toContain('notification');
  });
});

describe('signing out', () => {
  it('closes the connection soon after the session ends', async () => {
    const token = await api.signIn('deactivate');
    const c = await signedIn(token);
    expect((await api.call('POST', '/auth/logout', token)).statusCode).toBe(204);
    await until(() => c.code() !== undefined, 5000);
    expect(c.code()).toBe(4401);
  });
});
