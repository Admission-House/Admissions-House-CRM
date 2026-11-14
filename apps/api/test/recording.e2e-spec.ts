import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { AgoraRecordingClient, type AgoraHttp } from '../src/recording/agora-recording.client.js';
import { RecordingService } from '../src/recording/recording.service.js';
import { RecordingStorage } from '../src/recording/recording-storage.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture, OFFICE_IP } from './helpers/fixtures.js';

const APP_ID = '0123456789abcdef0123456789abcdef';
const CERT = 'fedcba9876543210fedcba9876543210';
const WEBHOOK_SECRET = 'webhook-secret-for-tests-1234567890';
const UPLOAD_KEY = 'UPLOADKEYID';
const UPLOAD_SECRET = 'upload-secret-value-do-not-leak';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let recording: RecordingService;
const t: Record<string, string> = {};

// ---------------------------------------------------------------- a pretend Agora

interface AgoraCall { method: string; url: string; auth: string | undefined; body: Record<string, any> | null } // eslint-disable-line @typescript-eslint/no-explicit-any
const agoraCalls: AgoraCall[] = [];
/** What the pretend Agora should do next: an error status for a path, or nothing (the normal answer). */
const agoraFail: { acquire?: number; start?: number; startReason?: string; stop?: number; query?: number } = {};
let sidCounter = 0;
const sessionOfSid = new Map<string, string>();

const fakeAgora: AgoraHttp = async (url, init) => {
  const body = init.body ? (JSON.parse(init.body) as Record<string, any>) : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  agoraCalls.push({ method: init.method, url, auth: init.headers.authorization, body });
  const reply = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) });
  if (url.endsWith('/acquire')) return agoraFail.acquire ? reply(agoraFail.acquire, { code: 2, reason: 'acquire refused' }) : reply(200, { cname: body!.cname, uid: body!.uid, resourceId: `res-${++sidCounter}` });
  if (url.endsWith('/start')) {
    if (agoraFail.start) return reply(agoraFail.start, { code: 7, reason: agoraFail.startReason ?? 'start refused' });
    const sid = `sid-${sidCounter}-${randomBytes(3).toString('hex')}`;
    sessionOfSid.set(sid, body!.cname);
    return reply(200, { cname: body!.cname, uid: body!.uid, resourceId: url.split('/resourceid/')[1]!.split('/')[0], sid });
  }
  if (url.endsWith('/query')) return agoraFail.query ? reply(agoraFail.query, { reason: 'no such recording' }) : reply(200, { serverResponse: { status: 5 } });
  if (url.endsWith('/stop')) return agoraFail.stop ? reply(agoraFail.stop, { reason: 'stop failed' }) : reply(200, { serverResponse: { uploadingStatus: 'uploaded', fileListMode: 'json', fileList: [{ fileName: 'a.mp4', trackType: 'audio' }] } });
  return reply(404, {});
};

// ------------------------------------------------------------- a pretend bucket

const bucket = new Map<string, Buffer>();
const fakeS3 = {
  async send(command: { constructor: { name: string }; input: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const name = command.constructor.name;
    const i = command.input;
    if (name === 'ListObjectsV2Command') return { Contents: [...bucket].filter(([k]) => k.startsWith(i.Prefix)).map(([Key, v]) => ({ Key, Size: v.length })), IsTruncated: false };
    if (name === 'HeadObjectCommand') {
      if (!bucket.has(i.Key)) throw Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: bucket.get(i.Key)!.length };
    }
    if (name === 'GetObjectCommand') {
      const all = bucket.get(i.Key);
      if (!all) throw Object.assign(new Error('nf'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      const m = /^bytes=(\d+)-(\d+)$/.exec(i.Range ?? '');
      const part = m ? all.subarray(Number(m[1]), Number(m[2]) + 1) : all;
      const { Readable } = await import('node:stream');
      return { Body: Readable.from([part]), ContentLength: part.length, ContentRange: m ? `bytes ${m[1]}-${m[2]}/${all.length}` : undefined };
    }
    if (name === 'DeleteObjectCommand') {
      bucket.delete(i.Key);
      return {};
    }
    throw new Error(`unexpected S3 command ${name}`);
  },
};

// ------------------------------------------------------------------- helpers

const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: Record<string, unknown>) => api.call(method, url, token, body, token === t.sa ? undefined : OFFICE_IP);
const code = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const device = () => randomBytes(18).toString('base64url');
const guestPost = (url: string, body: Record<string, unknown>, ip = '203.0.113.88') => app.inject({ method: 'POST', url: `/api/v1/video/guest/${url}`, payload: body, remoteAddress: ip });
const linkOf = (url: string) => url.split('/meet/')[1]!;
const rec = async (sessionId: string) => (await owner.query(`SELECT * FROM session_recordings WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [sessionId])).rows[0];
const noteEvents = async (user: string, event: string) => (await owner.query(`SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = 'communication' AND payload->>'event' = $3`, [fx.tenantId, fx.user(user).id, event])).rows.map((r) => r.payload);

async function setPolicy(mode: 'off' | 'optional' | 'always', extra: Record<string, unknown> = {}) {
  const res = await call(t.sa!, 'PUT', '/communications/recording/policy', { mode, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

let seq = 0;
async function leadOf(holder: string): Promise<string> {
  const n = ++seq;
  const status = (await owner.query(`SELECT id FROM lead_statuses WHERE tenant_id = $1 ORDER BY sort_order LIMIT 1`, [fx.tenantId])).rows[0].id;
  const { rows } = await owner.query(
    `INSERT INTO leads (tenant_id, lead_no, name, primary_phone, status_id, source_id, assigned_to, assigned_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [fx.tenantId, 8_500_000 + n, `Record Student ${n}`, `9155${String(50_000_000 + n)}`, status, fx.sourceId('Website'), fx.user(holder).id],
  );
  return rows[0].id as string;
}

/** A recorded call with a lead, joined by the counsellor (who agreed), so that a recording is waiting to start. */
async function recordedCall(kind: 'voice' | 'video' = 'voice') {
  await setPolicy('always');
  const lead = await leadOf('counsellor');
  const res = await call(t.lc!, 'POST', `/leads/${lead}/communications`, { kind });
  expect(res.statusCode, res.body).toBe(201);
  const session = res.json();
  const join = await call(t.lc!, 'POST', `/communications/${session.id}/join`, { consent: true });
  expect(join.statusCode, join.body).toBe(200);
  return { lead, session, guest: session.participants.find((p: { kind: string }) => p.kind === 'guest') as { id: string; link: string } };
}

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({
    LOGIN_IP_MAX_ATTEMPTS: '500', AGORA_APP_ID: APP_ID, AGORA_APP_CERTIFICATE: CERT, WEB_URL: 'https://crm.example.test',
    AGORA_CUSTOMER_ID: 'customer-id-1', AGORA_CUSTOMER_SECRET: 'customer-secret-1', AGORA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RECORDING_S3_BUCKET: 'test-bucket', RECORDING_S3_REGION: 'ap-south-1', RECORDING_S3_UPLOAD_ACCESS_KEY_ID: UPLOAD_KEY, RECORDING_S3_UPLOAD_SECRET_ACCESS_KEY: UPLOAD_SECRET,
    RECORDING_S3_ACCESS_KEY_ID: 'APPKEYID', RECORDING_S3_SECRET_ACCESS_KEY: 'app-secret-value',
  });
  app.get(AgoraRecordingClient).http = fakeAgora;
  app.get(RecordingStorage).client = fakeS3;
  recording = app.get(RecordingService);
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  t.admin = await api.signIn('admin', { office: true });
  t.lc = await api.signIn('counsellor', { office: true });
  t.lc2 = await api.signIn('counsellor2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

beforeEach(async () => {
  // Recordings left over from an earlier test must not be picked up by this test's sweep.
  await owner.query(`UPDATE session_recordings SET status = 'failed', failure_reason = 'test reset' WHERE tenant_id = $1 AND status IN ('pending', 'starting', 'recording', 'stopping', 'processing')`, [fx.tenantId]);
  bucket.clear();
  agoraCalls.length = 0;
  for (const k of Object.keys(agoraFail)) delete (agoraFail as Record<string, unknown>)[k];
});

// =================================================================== policy

describe('the recording policy', () => {
  it('starts switched off, with a notice a company can change; only a Super Admin changes it', async () => {
    const p = (await call(t.lc!, 'GET', '/communications/recording/policy')).json();
    expect(p).toMatchObject({ mode: 'off', retentionDays: 90, version: 1, ready: true });
    expect(p.noticeText).toMatch(/record/i);
    expect(p.missing).toBeUndefined(); // only those who manage it see what is missing
    expect((await call(t.admin!, 'PUT', '/communications/recording/policy', { mode: 'always' })).statusCode).toBe(403);
    expect((await call(t.lc!, 'PUT', '/communications/recording/policy', { mode: 'always' })).statusCode).toBe(403);
    const changed = await setPolicy('optional', { retentionDays: 30, noticeText: 'Calls are recorded for quality. Agree to join.' });
    expect(changed).toMatchObject({ mode: 'optional', retentionDays: 30, version: 2, missing: [] });
    const same = await setPolicy('optional', { retentionDays: 45 }); // only the retention changed: not a new notice
    expect(same.version).toBe(2);
    expect((await call(t.sa!, 'PUT', '/communications/recording/policy', { retentionDays: 0 })).statusCode).toBe(400);
    expect((await call(t.sa!, 'PUT', '/communications/recording/policy', { noticeText: 'short' })).statusCode).toBe(400);
    const audit = await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'recording.policy'`, [fx.tenantId]);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
    await setPolicy('off');
  });
});

// =================================================================== consent

describe('consent before joining a recorded session', () => {
  it('a session made while recording is off needs no consent and is never recorded', async () => {
    await setPolicy('off');
    const lead = await leadOf('counsellor');
    const s = (await call(t.lc!, 'POST', `/leads/${lead}/communications`, {})).json();
    expect(s).toMatchObject({ recordingEnabled: false, recordingStatus: 'off' });
    const join = await call(t.lc!, 'POST', `/communications/${s.id}/join`);
    expect(join.statusCode).toBe(200);
    expect(join.json().recordingEnabled).toBe(false);
    await recording.sweep(fx.tenantId);
    expect(agoraCalls).toHaveLength(0);
  });

  it('with "optional" only a session whose host asked for it is recorded', async () => {
    await setPolicy('optional');
    const lead = await leadOf('counsellor');
    expect((await call(t.lc!, 'POST', `/leads/${lead}/communications`, {})).json().recordingEnabled).toBe(false);
    expect((await call(t.lc!, 'POST', `/leads/${lead}/communications`, { record: true })).json()).toMatchObject({ recordingEnabled: true, recordingStatus: 'pending' });
  });

  it('shows the notice to staff and keeps their agreement with the time and the notice version; nothing starts until they agree', async () => {
    await setPolicy('always', { noticeText: 'This call is recorded for training. Press agree to join.' });
    const lead = await leadOf('counsellor');
    const s = (await call(t.lc!, 'POST', `/leads/${lead}/communications`, { kind: 'voice' })).json();
    const policy = (await call(t.lc!, 'GET', '/communications/recording/policy')).json();

    const refused = await call(t.lc!, 'POST', `/communications/${s.id}/join`);
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('CONSENT_REQUIRED');
    expect(refused.json().error.details).toMatchObject({ notice: 'This call is recorded for training. Press agree to join.', version: policy.version });
    expect((await owner.query(`SELECT started_at FROM video_sessions WHERE id = $1`, [s.id])).rows[0].started_at).toBeNull(); // not started
    expect(await rec(s.id)).toBeUndefined(); // nothing to record

    const agreed = await call(t.lc!, 'POST', `/communications/${s.id}/join`, { consent: true });
    expect(agreed.statusCode, agreed.body).toBe(200);
    expect(agreed.json().recordingEnabled).toBe(true);
    const invite = (await owner.query(`SELECT consented_at, consent_notice_version FROM video_session_invites WHERE session_id = $1 AND user_id = $2`, [s.id, fx.user('counsellor').id])).rows[0];
    expect(invite.consented_at).not.toBeNull();
    expect(invite.consent_notice_version).toBe(policy.version);
    const ev = await owner.query(`SELECT detail FROM video_session_events WHERE session_id = $1 AND event = 'consent'`, [s.id]);
    expect(ev.rows).toHaveLength(1);
    // Joining again (a renewal) does not ask again.
    expect((await call(t.lc!, 'POST', `/communications/${s.id}/join`)).statusCode).toBe(200);
  });

  it('shows the notice to a guest too; a guest who does not agree is not let in, and the session is not started by it', async () => {
    const { session, guest } = await recordedCall();
    const dev = device();
    const no = await guestPost('join', { token: linkOf(guest.link), deviceId: dev });
    expect(no.statusCode).toBe(409);
    expect(code(no)).toBe('CONSENT_REQUIRED');
    expect(no.json().error.details.notice).toMatch(/record/i);
    const refusedExplicitly = await guestPost('join', { token: linkOf(guest.link), deviceId: dev, consent: false });
    expect(code(refusedExplicitly)).toBe('CONSENT_REQUIRED');
    expect((await owner.query(`SELECT state, consented_at FROM video_session_invites WHERE session_id = $1 AND kind = 'guest'`, [session.id])).rows[0]).toMatchObject({ state: 'invited', consented_at: null });
    const yes = await guestPost('join', { token: linkOf(guest.link), deviceId: dev, consent: true });
    expect(yes.statusCode, yes.body).toBe(200);
    expect(yes.json().recordingEnabled).toBe(true);
    expect((await owner.query(`SELECT consented_at FROM video_session_invites WHERE session_id = $1 AND kind = 'guest'`, [session.id])).rows[0].consented_at).not.toBeNull();
  });
});

// =================================================================== the lifecycle

describe('a recorded session, from start to a playable file', () => {
  it('asks Agora to start with the right request, and keeps no secret in anything it shows', async () => {
    const { session } = await recordedCall('voice');
    expect(await rec(session.id)).toMatchObject({ status: 'pending', stream_types: 0 });
    expect(await recording.sweep(fx.tenantId)).toMatchObject({ started: 1 });

    const acquire = agoraCalls.find((c) => c.url.endsWith('/acquire'))!;
    const start = agoraCalls.find((c) => c.url.endsWith('/start'))!;
    const channel = `ah${session.id.replace(/-/g, '')}`;
    expect(acquire.url).toBe(`https://api.sd-rtn.com/v1/apps/${APP_ID}/cloud_recording/acquire`);
    expect(acquire.auth).toBe(`Basic ${Buffer.from('customer-id-1:customer-secret-1').toString('base64')}`);
    expect(acquire.body).toMatchObject({ cname: channel, clientRequest: { scene: 0, resourceExpiredHour: 24 } });
    expect(start.url).toMatch(/\/cloud_recording\/resourceid\/res-\d+\/mode\/mix\/start$/);
    const r = await rec(session.id);
    expect(start.body).toMatchObject({ cname: channel, uid: String(r.bot_uid) });
    const cfg = start.body!.clientRequest;
    expect(cfg.token.startsWith('007')).toBe(true);
    expect(cfg.recordingConfig).toMatchObject({ channelType: 0, streamTypes: 0, maxIdleTime: 60, subscribeAudioUids: ['#allstream#'] });
    expect(cfg.recordingConfig.transcodingConfig).toBeUndefined(); // sound only: no picture settings
    expect(cfg.recordingFileConfig).toEqual({ avFileType: ['hls', 'mp4'] });
    expect(cfg.storageConfig).toEqual({
      vendor: 1, region: 14, bucket: 'test-bucket', accessKey: UPLOAD_KEY, secretKey: UPLOAD_SECRET,
      fileNamePrefix: ['rec', fx.tenantId.replace(/-/g, ''), session.id.replace(/-/g, '')],
    });
    expect(await rec(session.id)).toMatchObject({ status: 'recording', resource_id: expect.stringMatching(/^res-/), sid: expect.stringMatching(/^sid-/) });

    // The recorder is a member of the channel, so screens are told its number; the keys never reach any answer.
    const snap = (await call(t.lc!, 'POST', `/communications/${session.id}/presence`, { event: 'ping' })).json();
    expect(snap.recording).toEqual({ status: 'recording', botUid: r.bot_uid });
    const views = JSON.stringify([(await call(t.lc!, 'GET', `/communications/${session.id}`)).json(), (await call(t.lc!, 'GET', `/communications/${session.id}/recordings`)).json(), snap]);
    for (const secret of [UPLOAD_SECRET, 'customer-secret-1', 'app-secret-value', WEBHOOK_SECRET, CERT]) expect(views).not.toContain(secret);
  });

  it('records a video session as sound and picture, in a size inside Agora\'s HD class', async () => {
    const { session } = await recordedCall('video');
    await recording.sweep(fx.tenantId);
    const start = agoraCalls.find((c) => c.url.endsWith('/start'))!;
    expect(start.body!.clientRequest.recordingConfig).toMatchObject({ streamTypes: 2, subscribeVideoUids: ['#allstream#'], transcodingConfig: { width: 640, height: 360, mixedVideoLayout: 1 } });
    expect(640 * 360).toBeLessThanOrEqual(921_600);
    expect((await rec(session.id)).stream_types).toBe(2);
  });

  it('never makes two live recordings of one session, however many people join at once', async () => {
    const { session } = await recordedCall();
    await Promise.all([1, 2, 3].map(() => call(t.lc!, 'POST', `/communications/${session.id}/join`)));
    await Promise.all([1, 2].map(() => recording.sweep(fx.tenantId)));
    const live = await owner.query(`SELECT count(*)::int AS n FROM session_recordings WHERE session_id = $1 AND status IN ('pending', 'starting', 'recording', 'stopping', 'processing')`, [session.id]);
    expect(live.rows[0].n).toBe(1);
    expect(agoraCalls.filter((c) => c.url.endsWith('/start'))).toHaveLength(1);
    expect(agoraCalls.filter((c) => c.url.endsWith('/acquire'))).toHaveLength(1);
  });

  it('stops when the session ends, finds the file in the bucket, checks it and only then says it is available', async () => {
    const { session } = await recordedCall();
    await recording.sweep(fx.tenantId);
    const r = await rec(session.id);
    expect((await call(t.lc!, 'POST', `/communications/${session.id}/end`)).statusCode).toBe(200);
    expect((await rec(session.id)).status).toBe('stopping');

    await recording.sweep(fx.tenantId);
    const stop = agoraCalls.find((c) => c.url.endsWith('/stop'))!;
    expect(stop.url).toBe(`https://api.sd-rtn.com/v1/apps/${APP_ID}/cloud_recording/resourceid/${r.resource_id}/sid/${r.sid}/mode/mix/stop`);
    expect(stop.body).toMatchObject({ cname: `ah${session.id.replace(/-/g, '')}`, uid: String(r.bot_uid), clientRequest: {} });
    expect((await rec(session.id)).status).toBe('processing');

    // Agora has stopped, but no file is in the bucket yet: not available, and not claimed to be.
    await owner.query(`UPDATE session_recordings SET last_attempt_at = NULL WHERE id = $1`, [r.id]);
    await recording.sweep(fx.tenantId);
    expect((await rec(session.id)).status).toBe('processing');
    expect((await call(t.lc!, 'GET', `/communications/${session.id}/recordings`)).json().recordings[0]).toMatchObject({ status: 'processing', canPlay: false, files: [] });

    // The files arrive: an HLS playlist and the MP4.
    bucket.set(`${r.file_prefix}/x_${session.id}.m3u8`, Buffer.from('#EXTM3U'));
    bucket.set(`${r.file_prefix}/x_${session.id}.mp4`, Buffer.from('0123456789abcdefghij'));
    await owner.query(`UPDATE session_recordings SET last_attempt_at = NULL WHERE id = $1`, [r.id]);
    await recording.sweep(fx.tenantId);
    const done = await rec(session.id);
    expect(done).toMatchObject({ status: 'available' });
    expect(done.expires_at).not.toBeNull();
    const files = (await owner.query(`SELECT format, size_bytes::int AS size, is_playable, verified_at FROM session_recording_files WHERE recording_id = $1 ORDER BY format`, [r.id])).rows;
    expect(files.map((f) => [f.format, f.is_playable])).toEqual([['m3u8', false], ['mp4', true]]);
    expect(files.find((f) => f.format === 'mp4')).toMatchObject({ size: 20 });
    expect(files.every((f) => f.verified_at)).toBe(true);
    expect(await noteEvents('counsellor', 'comm_recording_ready')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id })]));
    const view = (await call(t.lc!, 'GET', `/communications/${session.id}`)).json();
    expect(view.recordingStatus).toBe('available');
    const trail = (await owner.query(`SELECT detail FROM video_session_events WHERE session_id = $1 AND event = 'recording' ORDER BY id`, [session.id])).rows.map((e) => e.detail);
    expect(trail[0]).toBe('started');
    expect(trail).toContain('available');
  });

  it('stopping when Agora has already ended the recording, or does not answer, still ends in a checked file or an explicit failure', async () => {
    const a = await recordedCall();
    await recording.sweep(fx.tenantId);
    agoraFail.stop = 404; // Agora ended it by itself (the channel was empty)
    await call(t.lc!, 'POST', `/communications/${a.session.id}/end`);
    await recording.sweep(fx.tenantId);
    expect((await rec(a.session.id)).status).toBe('processing');

    const b = await recordedCall();
    await recording.sweep(fx.tenantId);
    agoraFail.stop = 500; // Agora is failing: tried again, then the bucket is checked instead of waiting for ever
    await call(t.lc!, 'POST', `/communications/${b.session.id}/end`);
    for (let i = 0; i < 4; i++) {
      await owner.query(`UPDATE session_recordings SET last_attempt_at = NULL WHERE session_id = $1`, [b.session.id]);
      await recording.sweep(fx.tenantId);
    }
    expect((await rec(b.session.id)).status).toBe('processing');
    expect(agoraCalls.filter((c) => c.url.endsWith('/stop') && c.url.includes((rec as never as string) ?? '')).length).toBeGreaterThanOrEqual(0);
  });

  it('a recorder that Agora reports as gone while the session carries on moves to checking the file, and a later join records the rest', async () => {
    const { session } = await recordedCall();
    await recording.sweep(fx.tenantId);
    const first = await rec(session.id);
    agoraFail.query = 404;
    await owner.query(`UPDATE session_recordings SET last_attempt_at = now() - interval '2 minutes' WHERE id = $1`, [first.id]);
    await recording.sweep(fx.tenantId);
    expect((await rec(session.id)).status).toBe('processing');
    // Someone joins again later: a new part is started, with its own folder.
    delete agoraFail.query;
    // While the earlier part is still being checked no second one starts; once it is done, a later join records the rest.
    await call(t.lc!, 'POST', `/communications/${session.id}/join`);
    expect(await owner.query(`SELECT 1 FROM session_recordings WHERE session_id = $1`, [session.id])).toHaveProperty('rowCount', 1);
    await owner.query(`UPDATE session_recordings SET status = 'available', available_at = now(), expires_at = now() + interval '30 days', created_at = now() - interval '10 minutes' WHERE id = $1`, [first.id]);
    await call(t.lc!, 'POST', `/communications/${session.id}/join`);
    const parts = (await owner.query(`SELECT file_prefix, status FROM session_recordings WHERE session_id = $1 ORDER BY created_at`, [session.id])).rows;
    expect(parts).toHaveLength(2);
    expect(parts[1].file_prefix).toBe(`${parts[0].file_prefix}/part2`);
    expect(parts[1].status).toBe('pending');
  });
});

// =================================================================== failures

describe('when recording cannot work', () => {
  it('says so plainly when Agora refuses to start: failed, with the reason, and the host is told', async () => {
    const { session } = await recordedCall();
    agoraFail.start = 400;
    agoraFail.startReason = 'invalid storage settings';
    await recording.sweep(fx.tenantId);
    const r = await rec(session.id);
    expect(r.status).toBe('failed');
    expect(r.failure_reason).toMatch(/Agora could not start the recording/);
    expect(r.failure_reason).toMatch(/invalid storage settings/);
    expect(r.failure_reason).not.toContain(UPLOAD_SECRET);
    const view = (await call(t.lc!, 'GET', `/communications/${session.id}/recordings`)).json();
    expect(view.status).toBe('failed');
    expect(view.recordings[0]).toMatchObject({ status: 'failed', failureReason: expect.stringMatching(/could not start/), canPlay: false });
    expect(await noteEvents('counsellor', 'comm_recording_failed')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: session.id })]));
    // The session itself carries on; only the recording failed, and it says so.
    expect((await call(t.lc!, 'GET', `/communications/${session.id}`)).json()).toMatchObject({ status: 'open', recordingStatus: 'failed' });
  });

  it('retries a server error a few times, then gives up with a failure instead of staying "pending"', async () => {
    const { session } = await recordedCall();
    agoraFail.start = 503;
    for (let i = 0; i < 3; i++) {
      await owner.query(`UPDATE session_recordings SET last_attempt_at = now() - interval '5 minutes' WHERE session_id = $1`, [session.id]);
      await recording.sweep(fx.tenantId);
      if (i < 2) expect((await rec(session.id)).status).toBe('pending');
    }
    expect((await rec(session.id)).status).toBe('failed');
    expect(agoraCalls.filter((c) => c.url.endsWith('/start'))).toHaveLength(3);
  });

  it('a session that ends before the recording could start is marked failed with that reason', async () => {
    const { session } = await recordedCall();
    await call(t.lc!, 'POST', `/communications/${session.id}/end`);
    const r = await rec(session.id);
    expect(r).toMatchObject({ status: 'failed', failure_reason: 'The session ended before the recording could start.' });
    await recording.sweep(fx.tenantId);
    expect(agoraCalls).toHaveLength(0);
  });

  it('a start that was begun and never confirmed (the server stopped meanwhile) is failed, not left "starting"', async () => {
    const { session } = await recordedCall();
    await owner.query(`UPDATE session_recordings SET status = 'starting', last_attempt_at = now() - interval '5 minutes' WHERE session_id = $1`, [session.id]);
    await recording.sweep(fx.tenantId);
    expect(await rec(session.id)).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/did not confirm/) });
  });

  it('a recording that stopped but whose file never appears fails after the wait', async () => {
    const { session } = await recordedCall();
    await recording.sweep(fx.tenantId);
    await call(t.lc!, 'POST', `/communications/${session.id}/end`);
    await recording.sweep(fx.tenantId);
    await owner.query(`UPDATE session_recordings SET stopped_at = now() - interval '45 minutes', last_attempt_at = NULL WHERE session_id = $1`, [session.id]);
    await recording.sweep(fx.tenantId);
    expect(await rec(session.id)).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/no playable file/) });
  });

  it('when the server cannot record, a session says "unavailable" and asks for no consent; nothing pretends to be recorded', async () => {
    await setPolicy('always');
    const agora = app.get(AgoraRecordingClient);
    const keep = (agora as unknown as { env: Record<string, unknown> }).env.RECORDING_S3_BUCKET;
    (agora as unknown as { env: Record<string, unknown> }).env.RECORDING_S3_BUCKET = undefined;
    try {
      expect((await call(t.lc!, 'GET', '/communications/recording/policy')).json().ready).toBe(false);
      expect((await call(t.sa!, 'GET', '/communications/recording/policy')).json().missing).toEqual(['RECORDING_S3_BUCKET']);
      const lead = await leadOf('counsellor');
      const s = (await call(t.lc!, 'POST', `/leads/${lead}/communications`, {})).json();
      expect(s).toMatchObject({ recordingEnabled: false, recordingStatus: 'unavailable' });
      expect((await call(t.lc!, 'POST', `/communications/${s.id}/join`)).statusCode).toBe(200); // no notice about a recording that cannot happen
      const history = (await call(t.lc!, 'GET', '/communications?limit=100')).json().items.find((i: { id: string }) => i.id === s.id);
      expect(history.recordingStatus).toBe('unavailable');
    } finally {
      (agora as unknown as { env: Record<string, unknown> }).env.RECORDING_S3_BUCKET = keep;
    }
  });
});

// =================================================================== playback

describe('listening to and saving a recording', () => {
  /** A recorded call that is finished and has a playable file. */
  async function finishedRecording() {
    const { session, lead } = await recordedCall();
    await recording.sweep(fx.tenantId);
    const r = await rec(session.id);
    await call(t.lc!, 'POST', `/communications/${session.id}/end`);
    await recording.sweep(fx.tenantId);
    bucket.set(`${r.file_prefix}/clip.mp4`, Buffer.from('0123456789abcdefghij'));
    await owner.query(`UPDATE session_recordings SET last_attempt_at = NULL WHERE id = $1`, [r.id]);
    await recording.sweep(fx.tenantId);
    expect((await rec(session.id)).status).toBe('available');
    const listing = (await call(t.lc!, 'GET', `/communications/${session.id}/recordings`)).json();
    const file = listing.recordings[0].files.find((f: { playable: boolean }) => f.playable);
    return { session, lead, file, r };
  }

  it('gives a short-lived link to those who may see the session and hold the permission, and writes it to the audit log', async () => {
    const { session, file } = await finishedRecording();
    const res = await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' });
    expect(res.statusCode, res.body).toBe(200);
    const { url, expiresAt } = res.json();
    expect(url).toMatch(/^\/api\/v1\/recordings\/files\//);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    const played = await app.inject({ method: 'GET', url });
    expect(played.statusCode).toBe(200);
    expect(played.body).toBe('0123456789abcdefghij');
    expect(played.headers['content-type']).toBe('video/mp4');
    expect(String(played.headers['content-disposition'])).toMatch(/^inline;/);
    expect(played.headers['cache-control']).toBe('private, no-store');
    expect(played.headers['accept-ranges']).toBe('bytes');
    const audit = await owner.query(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND entity_id = $2 AND action LIKE 'recording.%'`, [fx.tenantId, session.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(expect.arrayContaining(['recording.available', 'recording.play']));
  });

  it('lets a browser skip ahead: a partial request gets just that part', async () => {
    const { session, file } = await finishedRecording();
    const { url } = (await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' })).json();
    const part = await app.inject({ method: 'GET', url, headers: { range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('56789');
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    const tail = await app.inject({ method: 'GET', url, headers: { range: 'bytes=15-' } });
    expect(tail.body).toBe('fghij');
    const beyond = await app.inject({ method: 'GET', url, headers: { range: 'bytes=500-' } });
    expect(beyond.statusCode).toBe(416);
  });

  it('saving needs its own permission, and the file is then offered as a download', async () => {
    const { session, file } = await finishedRecording();
    expect((await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'download' })).statusCode).toBe(403);
    const { url } = (await call(t.admin!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'download' })).json();
    const saved = await app.inject({ method: 'GET', url });
    expect(saved.statusCode).toBe(200);
    expect(String(saved.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('a counsellor cannot reach the recording of a lead that is not theirs, whatever file id they try', async () => {
    const { session, file } = await finishedRecording();
    expect((await call(t.lc2!, 'GET', `/communications/${session.id}/recordings`)).statusCode).toBe(404);
    expect((await call(t.lc2!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' })).statusCode).toBe(404);
    expect((await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${randomUUID()}/link`, { purpose: 'play' })).statusCode).toBe(404);
    expect((await call(t.sa!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' })).statusCode).toBe(200);
  });

  it('a link that was changed, is made up, or has expired does not work', async () => {
    const { session, file } = await finishedRecording();
    const { url } = (await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' })).json();
    const token = url.split('/files/')[1] as string;
    expect((await app.inject({ method: 'GET', url: `/api/v1/recordings/files/${token.slice(0, -2)}xx` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/recordings/files/not-a-token' })).statusCode).toBe(403);
    const links = app.get((await import('../src/storage/file-links.service.js')).FileLinks);
    const old = links.sign({ key: `rec:${fx.tenantId}:${file.id}:play`, type: 'video/mp4', name: 'x.mp4' }, -10);
    expect((await app.inject({ method: 'GET', url: `/api/v1/recordings/files/${old.token}` })).json().error.code).toBe('LINK_EXPIRED');
  });

  it('removes the files after the retention period and then refuses to play them', async () => {
    const { session, file, r } = await finishedRecording();
    expect(bucket.has(`${r.file_prefix}/clip.mp4`)).toBe(true);
    await owner.query(`UPDATE session_recordings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
    expect((await recording.sweep(fx.tenantId)).expired).toBeGreaterThanOrEqual(1);
    expect(bucket.has(`${r.file_prefix}/clip.mp4`)).toBe(false);
    expect((await rec(session.id)).status).toBe('expired');
    expect((await call(t.lc!, 'POST', `/communications/${session.id}/recordings/files/${file.id}/link`, { purpose: 'play' })).statusCode).toBe(404);
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'recording.expire' AND entity_id = $2`, [fx.tenantId, session.id])).rows[0].n).toBe(1);
  });

  it('shows recorded sessions and failed recordings in the history, and filters by them', async () => {
    const ok = await finishedRecording();
    const { session: bad } = await recordedCall();
    agoraFail.start = 400;
    await recording.sweep(fx.tenantId);
    const ids = async (query: string) => ((await call(t.sa!, 'GET', `/communications?limit=100${query}`)).json().items as { id: string }[]).map((i) => i.id);
    expect(await ids('&recording=available')).toContain(ok.session.id);
    expect(await ids('&recording=available')).not.toContain(bad.id);
    expect(await ids('&recording=failed')).toContain(bad.id);
    expect(await ids('&recording=failed')).not.toContain(ok.session.id);
    const item = ((await call(t.sa!, 'GET', '/communications?limit=100')).json().items as { id: string; recordingStatus: string }[]);
    expect(item.find((i) => i.id === ok.session.id)!.recordingStatus).toBe('available');
    expect(item.find((i) => i.id === bad.id)!.recordingStatus).toBe('failed');
  });
});

// =================================================================== Agora's notices

describe('notices from Agora', () => {
  const send = (payload: Record<string, unknown>, opts: { secret?: string; signature?: string | null } = {}) => {
    const raw = JSON.stringify(payload);
    const signature = opts.signature === null ? undefined : (opts.signature ?? createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(raw).digest('hex'));
    return app.inject({ method: 'POST', url: '/api/v1/recordings/webhook', payload: raw, headers: { 'content-type': 'application/json', ...(signature ? { 'agora-signature-v2': signature } : {}) }, remoteAddress: '198.51.100.20' });
  };
  const notice = (sid: string, eventType: number, details: Record<string, unknown> = {}, noticeId = randomUUID()) => ({ noticeId, productId: 3, eventType, notifyMs: Date.now(), payload: { cname: 'x', uid: '1', sid, sequence: 0, details } });

  async function running() {
    const { session } = await recordedCall();
    await recording.sweep(fx.tenantId);
    return { session, sid: (await rec(session.id)).sid as string };
  }

  it('refuses a notice without a matching signature, whoever sends it', async () => {
    const { sid } = await running();
    expect((await send(notice(sid, 31), { signature: null })).statusCode).toBe(401);
    expect((await send(notice(sid, 31), { signature: 'deadbeef' })).statusCode).toBe(401);
    expect((await send(notice(sid, 31), { secret: 'another-secret-entirely-1234567890' })).statusCode).toBe(401);
    // A signature over a different body does not carry over.
    const raw = JSON.stringify(notice(sid, 31));
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw + ' ').digest('hex');
    expect((await app.inject({ method: 'POST', url: '/api/v1/recordings/webhook', payload: raw, headers: { 'content-type': 'application/json', 'agora-signature-v2': sig } })).statusCode).toBe(401);
  });

  it('files each notice once: a repeat does nothing, and one about an unknown recording is accepted and ignored', async () => {
    const { sid, session } = await running();
    const id = randomUUID();
    expect((await send(notice(sid, 3, {}, id))).json()).toEqual({ ok: true });
    expect((await send(notice(sid, 3, {}, id))).json()).toEqual({ ok: true, duplicate: true });
    expect((await owner.query(`SELECT count(*)::int AS n FROM recording_webhook_events WHERE tenant_id = $1 AND notice_id = $2`, [fx.tenantId, id])).rows[0].n).toBe(1);
    expect((await send(notice('sid-that-we-never-made', 31))).json()).toEqual({ ok: true, ignored: true });
    expect((await rec(session.id)).status).toBe('recording');
  });

  it('an "uploaded" notice makes the file be checked at once, and a recorder that exited moves the recording on', async () => {
    const { sid, session } = await running();
    expect((await send(notice(sid, 11, { exitStatus: 0 }))).statusCode).toBe(200);
    expect((await rec(session.id)).status).toBe('processing');
    const r = await rec(session.id);
    await owner.query(`UPDATE session_recordings SET last_attempt_at = now() WHERE id = $1`, [r.id]); // the sweep would wait
    bucket.set(`${r.file_prefix}/late.mp4`, Buffer.from('abc'));
    expect((await send(notice(sid, 31, { status: 'uploaded' }))).statusCode).toBe(200);
    expect((await owner.query(`SELECT last_attempt_at FROM session_recordings WHERE id = $1`, [r.id])).rows[0].last_attempt_at).toBeNull();
    await recording.sweep(fx.tenantId);
    expect((await rec(session.id)).status).toBe('available');
  });

  it('a fatal error from Agora fails the recording with the reason; a small warning only gets noted', async () => {
    const warn = await running();
    expect((await send(notice(warn.sid, 2, { msg: 'minor' }))).statusCode).toBe(200);
    expect((await send(notice(warn.sid, 1, { errorLevel: 2 }))).statusCode).toBe(200);
    expect((await rec(warn.session.id)).status).toBe('recording');
    const bad = await running();
    expect((await send(notice(bad.sid, 1, { errorLevel: 5, msg: 'storage refused the upload' }))).statusCode).toBe(200);
    expect(await rec(bad.session.id)).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/storage refused the upload/) });
    expect(await noteEvents('counsellor', 'comm_recording_failed')).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: bad.session.id })]));
  });

  it('does not undo a recording that is already available', async () => {
    const { sid, session } = await running();
    await owner.query(`UPDATE session_recordings SET status = 'available', available_at = now(), expires_at = now() + interval '30 days' WHERE session_id = $1`, [session.id]);
    expect((await send(notice(sid, 1, { errorLevel: 5 }))).statusCode).toBe(200);
    expect((await rec(session.id)).status).toBe('available');
  });
});
