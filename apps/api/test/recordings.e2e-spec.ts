import { rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { RecordingFetcher } from '../src/telephony/recording-fetcher.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let server: http.Server;
let base = '';
let webhookKey = '';
const t: Record<string, string> = {};
const storageRoot = resolve(process.env.STORAGE_DIR ?? './.tmp-storage');

const MP3 = Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000'), Buffer.alloc(3000, 0x41)]);
const WAV = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '), Buffer.alloc(200)]);

/** A stand-in for the provider's recording server. */
const files: Record<string, { status?: number; type?: string; body?: Buffer; location?: string }> = {
  '/good.mp3': { type: 'audio/mpeg', body: MP3 },
  '/good.wav': { type: 'audio/wav', body: WAV },
  '/page.mp3': { type: 'audio/mpeg', body: Buffer.from('<html><script>alert(1)</script></html>          ') },
  '/missing.mp3': { status: 404, body: Buffer.from('nope') },
  '/moved.mp3': { status: 302, location: '/good.mp3' },
  '/huge.mp3': { type: 'audio/mpeg', body: Buffer.concat([MP3, Buffer.alloc(5000)]) },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const f = files[req.url ?? ''];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(f.status ?? 200, { ...(f.type && { 'content-type': f.type }), ...(f.location && { location: f.location }) });
    res.end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500', RECORDING_MAX_BYTES: '4096' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  const saved = await api.call('PUT', '/telephony/connection', t.sa!, { provider: 'generic', config: { simulate: true } });
  webhookKey = saved.json().webhookKey;
  // The test server is on 127.0.0.1, which the settings API rightly refuses as a host name.
  await owner.query(`UPDATE telephony_connections SET recording_hosts = '{127.0.0.1}' WHERE tenant_id = $1`, [fx.tenantId]);
});

afterAll(async () => {
  await app?.close();
  await new Promise((r) => server?.close(r));
  await fx?.cleanup();
  if (fx) rmSync(join(storageRoot, fx.tenantId), { recursive: true, force: true });
  await owner?.end();
});

let counter = 0;
const phone = () => `9${String(600_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const hook = (events: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/telephony/webhook', payload: { events } as never, headers: { authorization: `Bearer ${webhookKey}` } });
const fetcher = () => app.get(RecordingFetcher);

/** A finished call of lc1's with a recording address, returning the call id. */
async function callWithRecording(path: string, hostBase = base): Promise<string> {
  const lead = await api.call('POST', '/leads', t.lc1!, { name: 'Recorded', phone: phone(), sourceId: fx.sourceId('Website') });
  const customer = lead.json().phone ?? (await owner.query(`SELECT primary_phone FROM leads WHERE id = $1`, [lead.json().id])).rows[0].primary_phone;
  const id = `rec-${Date.now()}-${++counter}`;
  const at = new Date().toISOString();
  await owner.query(`UPDATE users SET phone = '9810000001' WHERE id = $1`, [fx.user('lc1').id]);
  const res = await hook([
    { providerCallId: id, event: 'answered', direction: 'incoming', customerNumber: customer, agentNumber: '9810000001', at },
    { providerCallId: id, event: 'ended', direction: 'incoming', customerNumber: customer, at, durationSec: 30 },
    { providerCallId: id, event: 'recording', direction: 'incoming', customerNumber: customer, at, recordingUrl: `${hostBase}${path}` },
  ]);
  expect(res.statusCode, res.body).toBe(200);
  return (await owner.query(`SELECT id FROM calls WHERE tenant_id = $1 AND provider_call_id = $2`, [fx.tenantId, id])).rows[0].id;
}
const recording = async (callId: string) => (await owner.query(`SELECT * FROM call_recordings WHERE call_id = $1`, [callId])).rows[0];
/** Makes a waiting recording due for another try, as time passing would. */
const makeDue = (callId: string) => owner.query(`UPDATE call_recordings SET last_attempt_at = now() - interval '1 day' WHERE call_id = $1`, [callId]);

// ================================================================ downloading

describe('downloading a recording', () => {
  it('waits until the fetcher runs, then stores the audio privately', async () => {
    const id = await callWithRecording('/good.mp3');
    expect(await recording(id)).toMatchObject({ status: 'pending', file_key: null, attempts: 0 });
    expect((await api.call('GET', `/calls/${id}`, t.lc1!)).json().recording).toBe('pending');

    const stored = await fetcher().runOnce();
    expect(stored, JSON.stringify(await recording(id))).toBeGreaterThanOrEqual(1);
    const row = await recording(id);
    expect(row).toMatchObject({ status: 'stored', size_bytes: MP3.length, attempts: 1, last_error: null });
    expect(row.file_key).toBe(`${fx.tenantId}/calls/${id}.mp3`);
    expect((await api.call('GET', `/calls/${id}`, t.lc1!)).json().recording).toBe('stored');
  });

  it('stores one recording per call even if the provider reports it twice', async () => {
    const id = await callWithRecording('/good.wav');
    const call = (await owner.query(`SELECT provider_call_id, counterparty FROM calls WHERE id = $1`, [id])).rows[0];
    await hook([{ providerCallId: call.provider_call_id, event: 'recording', direction: 'incoming', customerNumber: call.counterparty, at: new Date(Date.now() + 5000).toISOString(), recordingUrl: `${base}/good.mp3` }]);
    expect(Number((await owner.query(`SELECT count(*) FROM call_recordings WHERE call_id = $1`, [id])).rows[0].count)).toBe(1);
    expect((await recording(id)).source_url).toBe(`${base}/good.wav`);
  });

  it.each([
    ['a page that is not audio', '/page.mp3', 'is not audio'],
    ['an error from the provider', '/missing.mp3', 'answered 404'],
    ['a redirect', '/moved.mp3', 'answered 302'],
    ['a file over the size limit', '/huge.mp3', 'larger than the limit'],
  ])('does not store %s, and says why', async (_n, path, reason) => {
    const id = await callWithRecording(path);
    await fetcher().runOnce();
    const row = await recording(id);
    expect(row.status).toBe('pending');
    expect(row.file_key).toBeNull();
    expect(row.last_error).toContain(reason);
    expect((await api.call('GET', `/calls/${id}/recording`, t.sa!)).statusCode).toBe(409);
  });

  it('does not fetch from a host the company did not name', async () => {
    const id = await callWithRecording('/good.mp3', 'http://localhost:1');
    await fetcher().runOnce();
    expect((await recording(id)).last_error).toContain('is not allowed for recordings');
    const odd = await callWithRecording('/good.mp3', 'ftp://127.0.0.1');
    await fetcher().runOnce();
    expect((await recording(odd)).last_error).toContain('must use https');
  });

  it('tries again later, and gives up after five attempts', async () => {
    const id = await callWithRecording('/missing.mp3');
    await fetcher().runOnce();
    expect((await recording(id)).attempts).toBe(1);
    await fetcher().runOnce(); // too soon: waits its turn
    expect((await recording(id)).attempts).toBe(1);

    for (let i = 0; i < 4; i++) {
      await makeDue(id);
      await fetcher().runOnce();
    }
    expect(await recording(id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await api.call('GET', `/calls/${id}`, t.lc1!)).json().recording).toBe('failed');
    const res = await api.call('GET', `/calls/${id}/recording`, t.sa!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('could not be downloaded');
    await makeDue(id);
    await fetcher().runOnce();
    expect((await recording(id)).attempts).toBe(5); // no more tries
  });

  it('succeeds on a retry once the provider has the file', async () => {
    files['/late.mp3'] = { status: 404 };
    const id = await callWithRecording('/late.mp3');
    await fetcher().runOnce();
    expect((await recording(id)).status).toBe('pending');
    files['/late.mp3'] = { type: 'audio/mpeg', body: MP3 };
    await makeDue(id);
    await fetcher().runOnce();
    expect(await recording(id)).toMatchObject({ status: 'stored', attempts: 2 });
  });
});

// ================================================================== listening

describe('listening to a recording', () => {
  let callId: string;

  beforeAll(async () => {
    callId = await callWithRecording('/good.mp3');
    await fetcher().runOnce();
  });

  it('returns the audio with headers that keep it from doing anything else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/calls/${callId}/recording`, headers: { authorization: `Bearer ${t.admin}` } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(MP3)).toBe(true);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toMatch(/call-91\d{10}-\d{4}-\d{2}-\d{2}\.mp3/);
  });

  it('gives a link a browser can play, and writes each use to the audit log', async () => {
    const before = Number((await owner.query(`SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = 'call.listen'`, [fx.tenantId])).rows[0].count);
    const link = await api.call('POST', `/calls/${callId}/recording/link`, t.admin!);
    expect(link.statusCode).toBe(200);
    const play = await app.inject({ method: 'GET', url: link.json().url });
    expect(play.statusCode).toBe(200);
    expect(play.rawPayload.equals(MP3)).toBe(true);
    await api.call('GET', `/calls/${callId}/recording`, t.admin!);

    const rows = (await owner.query(`SELECT actor_id, entity_id FROM audit_logs WHERE tenant_id = $1 AND action = 'call.listen' ORDER BY id DESC`, [fx.tenantId])).rows;
    expect(rows.length - before).toBe(2);
    expect(rows[0]).toEqual({ actor_id: fx.user('admin').id, entity_id: callId });
  });

  it('follows the data scope and the permission', async () => {
    expect((await api.call('GET', `/calls/${callId}/recording`, t.lc2!)).statusCode).toBe(403); // a counsellor may not listen at all
    expect((await api.call('GET', `/calls/${callId}/recording`, t.admin2!)).statusCode).toBe(404); // another team's admin cannot see the call
    expect((await api.call('GET', `/calls/${callId}/recording`, t.sa!)).statusCode).toBe(200);
    expect((await api.call('POST', `/calls/${callId}/recording/link`, t.lc1!)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/calls/${callId}/recording` })).statusCode).toBe(401);
  });

  it('is not found for a call without a recording, and not ready while still waiting', async () => {
    const lead = await api.call('POST', '/leads', t.lc1!, { name: 'No Rec', phone: phone(), sourceId: fx.sourceId('Website') });
    const placed = await api.call('POST', `/leads/${lead.json().id}/call`, t.lc1!, {});
    expect((await api.call('GET', `/calls/${placed.json().id}/recording`, t.sa!)).statusCode).toBe(404);
    await owner.query(`UPDATE calls SET outcome = 'failed' WHERE id = $1`, [placed.json().id]);

    const waiting = await callWithRecording('/good.mp3');
    const res = await api.call('GET', `/calls/${waiting}/recording`, t.sa!);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('RECORDING_NOT_READY');
  });
});
