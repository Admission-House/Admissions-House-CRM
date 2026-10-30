import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { png } from '../src/documents/file-rules.spec.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart, UploadFile } from './helpers/multipart.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sa: string;
let admin: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const sendLogo = (token: string, file: UploadFile) => {
  const { payload, contentType } = multipart({}, [file]);
  return app.inject({ method: 'POST', url: '/api/v1/company/logo', payload, remoteAddress: '203.0.113.50', headers: { authorization: `Bearer ${token}`, 'content-type': contentType } });
};

describe('company profile', () => {
  it('lets the Super Admin set the names, contact address and colours, and records the change', async () => {
    const res = await api.call('PUT', '/company', sa, { productName: 'Acme Admissions CRM', contactEmail: 'Help@Acme.Example', brandColor: '#0A3B39', accentColor: '#00dfc2' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ productName: 'Acme Admissions CRM', contactEmail: 'help@acme.example', brandColor: '#0a3b39', accentColor: '#00dfc2', hasLogo: false });

    const me = (await api.call('GET', '/auth/me', sa)).json();
    expect(me.company).toMatchObject({ productName: 'Acme Admissions CRM', brandColor: '#0a3b39', accentColor: '#00dfc2', hasLogo: false });

    const logged = (await owner.query(`SELECT before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'company.update' ORDER BY id DESC LIMIT 1`, [fx.tenantId])).rows[0];
    expect(logged.after).toMatchObject({ productName: 'Acme Admissions CRM' });
  });

  it('refuses a colour that is not a colour, an empty change and a name that is too short', async () => {
    expect(errorCode(await api.call('PUT', '/company', sa, { brandColor: 'teal' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('PUT', '/company', sa, {}))).toBe('VALIDATION_FAILED');
    expect(errorCode(await api.call('PUT', '/company', sa, { name: 'A' }))).toBe('VALIDATION_FAILED');
    expect((await api.call('PUT', '/company', sa, { brandColor: null })).json().brandColor).toBeNull(); // back to the default
  });

  it('can be read by anyone signed in, and changed only by those who manage settings', async () => {
    expect((await api.call('GET', '/company', admin)).statusCode).toBe(200);
    expect((await api.call('PUT', '/company', admin, { productName: 'Hijacked' })).statusCode).toBe(403);
    expect((await sendLogo(admin, { filename: 'logo.png', type: 'image/png', data: png() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/company' })).statusCode).toBe(401);
  });
});

describe('company logo', () => {
  it('stores a real picture, serves it back, and replaces it', async () => {
    expect((await api.call('GET', '/company/logo', sa)).statusCode).toBe(404);

    const set = await sendLogo(sa, { filename: 'whatever.txt', type: 'text/plain', data: png() }); // judged by content, not name
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().hasLogo).toBe(true);
    expect((await api.call('GET', '/auth/me', sa)).json().company.hasLogo).toBe(true);

    const file = await api.call('GET', '/company/logo', admin);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.length).toBe(png().length);

    expect((await sendLogo(sa, { filename: 'again.png', type: 'image/png', data: png() })).statusCode).toBe(200);
    expect((await api.call('GET', '/company/logo', sa)).statusCode).toBe(200);
  });

  it('refuses a file that is not a JPG or PNG, or is too big, and can remove the logo', async () => {
    expect(errorCode(await sendLogo(sa, { filename: 'logo.png', type: 'image/png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }))).toBe('UNSUPPORTED_FILE');
    const big = Buffer.concat([png(), Buffer.alloc(520 * 1024)]);
    expect([errorCode(await sendLogo(sa, { filename: 'big.png', type: 'image/png', data: big }))]).toEqual(['FILE_TOO_LARGE']);

    const removed = await api.call('DELETE', '/company/logo', sa);
    expect(removed.json().hasLogo).toBe(false);
    expect((await api.call('GET', '/company/logo', sa)).statusCode).toBe(404);
  });
});
