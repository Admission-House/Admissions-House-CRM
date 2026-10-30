import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { jpeg, pdf, png } from '../src/documents/file-rules.spec.js';
import { FileLinks } from '../src/storage/file-links.service.js';
import { startApp } from './helpers/app.js';
import { Client, makeClient } from './helpers/client.js';
import { createFixture, Fixture } from './helpers/fixtures.js';
import { multipart, UploadFile } from './helpers/multipart.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const storageRoot = resolve(process.env.STORAGE_DIR ?? './.tmp-storage');

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '500' });
  api = makeClient(app, fx);
  t.sa = await api.signIn('super');
  for (const name of ['admin', 'admin2', 'lc1', 'lc2']) t[name] = await api.signIn(name, { office: true });

  ids.course = (await api.call('POST', '/courses', t.sa!, { name: 'B.Tech', level: 'UG' })).json().id;
  ids.college = (await api.call('POST', '/colleges', t.sa!, { name: 'Alpha University', courses: [{ courseId: ids.course, deliveryMode: 'regular' }] })).json().id;
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  if (fx) rmSync(join(storageRoot, fx.tenantId), { recursive: true, force: true });
  await owner?.end();
});

// ------------------------------------------------------------------ helpers

let counter = 0;
const phone = () => `9${String(200_000_000 + ++counter).padStart(9, '0')}`;
const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;

async function lead(token = t.lc1!) {
  const res = await api.call('POST', '/leads', token, { name: 'Doc Lead', phone: phone(), sourceId: fx.sourceId('Website') });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

/** Sends an upload the way a browser would. */
function upload(token: string, leadId: string, fields: Record<string, string>, files: UploadFile[]) {
  const { payload, contentType } = multipart(fields, files);
  return app.inject({
    method: 'POST', url: `/api/v1/leads/${leadId}/documents`, payload, remoteAddress: '203.0.113.50',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
  });
}
const send = (token: string, leadId: string, docType: string, file: UploadFile, extra: Record<string, string> = {}) =>
  upload(token, leadId, { docType, ...extra }, [file]);

const get = (token: string, path: string) => api.call('GET', path, token);
const list = async (token: string, leadId: string) => (await get(token, `/leads/${leadId}/documents`)).json();
const filesOnDisk = (): string[] => {
  const dir = join(storageRoot, fx.tenantId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
};

const photo = (name = 'photo.jpg') => ({ filename: name, type: 'image/jpeg', data: jpeg() });

// ===================================================================== upload

describe('uploading a document', () => {
  it('stores the file privately under a name the server chose, and records it', async () => {
    const l = await lead();
    const before = filesOnDisk().length;
    const res = await send(t.lc1!, l.id, 'photo', photo('My Passport Photo.jpg'));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ docType: 'photo', name: 'My Passport Photo.jpg', mimeType: 'image/jpeg', sizeBytes: jpeg().length, uploadedBy: 'lc1', shortlist: null });

    const stored = filesOnDisk();
    expect(stored).toHaveLength(before + 1);
    const path = stored.find((p) => p.includes(l.id))!;
    expect(path).toMatch(new RegExp(`${fx.tenantId}[\\\\/]${l.id}[\\\\/][0-9a-f-]{36}\\.jpg$`));
    expect(path).not.toContain('Passport'); // the person's file name is never part of the path
    expect(readFileSync(path).equals(jpeg())).toBe(true);

    const row = (await owner.query(`SELECT sha256, file_key FROM lead_documents WHERE id = $1`, [res.json().id])).rows[0];
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.file_key).toContain(l.id);

    const history = (await api.call('GET', `/leads/${l.id}/activities?limit=50`, t.lc1!)).json().items.find((a: { type: string }) => a.type === 'document');
    expect(history).toMatchObject({ field: 'photo', newValue: 'My Passport Photo.jpg', remark: 'Uploaded' });
    expect((await list(t.lc1!, l.id)).map((d: { id: string }) => d.id)).toEqual([res.json().id]);
  });

  it('goes by what the file really is, not by its name or the type the browser claimed', async () => {
    const l = await lead();
    const asPdfName = await send(t.lc1!, l.id, 'tenth', { filename: 'marksheet.pdf', type: 'application/pdf', data: png() });
    expect(asPdfName.statusCode).toBe(201);
    expect(asPdfName.json()).toMatchObject({ mimeType: 'image/png', name: 'marksheet.png' });
    expect(filesOnDisk().some((p) => p.includes(l.id) && p.endsWith('.png'))).toBe(true);
  });

  it.each([
    ['a text file named like a picture', { filename: 'photo.jpg', type: 'image/jpeg', data: Buffer.from('this is not a picture at all, just words') }],
    ['a web page named like a PDF', { filename: 'doc.pdf', type: 'application/pdf', data: Buffer.from('<html><script>alert(1)</script></html>        ') }],
    ['a program', { filename: 'doc.pdf', type: 'application/pdf', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(80)]) }],
    ['a zip archive', { filename: 'doc.jpg', type: 'image/jpeg', data: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(80)]) }],
    ['an SVG picture', { filename: 'logo.png', type: 'image/png', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>') }],
  ])('refuses %s', async (_n, file) => {
    const l = await lead();
    const before = filesOnDisk().length;
    const res = await send(t.lc1!, l.id, 'other', file);
    expect(res.statusCode, res.body).toBe(415);
    expect(errorCode(res)).toBe('UNSUPPORTED_FILE');
    expect(filesOnDisk()).toHaveLength(before);
    expect(await list(t.lc1!, l.id)).toEqual([]);
  });

  it('refuses a PDF that carries a script or opens things by itself', async () => {
    const l = await lead();
    const res = await send(t.lc1!, l.id, 'other', { filename: 'form.pdf', data: pdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>') });
    expect(res.statusCode).toBe(415);
    expect(errorCode(res)).toBe('UNSAFE_FILE');
    expect(await list(t.lc1!, l.id)).toEqual([]);
    expect((await send(t.lc1!, l.id, 'other', { filename: 'ok.pdf', data: pdf() })).statusCode).toBe(201);
  });

  it('keeps a clean name for the file, in any script', async () => {
    const l = await lead();
    const traversal = await send(t.lc1!, l.id, 'other', photo('../../etc/evil.jpg'));
    expect(traversal.json().name).toBe('evil.jpg');
    const hindi = await send(t.lc1!, l.id, 'other', photo('सिया का आधार.jpg'));
    expect(hindi.json().name).toBe('सिया का आधार.jpg');
    expect(filesOnDisk().every((p) => p.startsWith(storageRoot))).toBe(true);
  });

  it('accepts a file of exactly the size limit and refuses one byte more, storing nothing', async () => {
    const limit = 2 * 1024 * 1024;
    const l = await lead();
    const atLimit = Buffer.concat([jpeg(), Buffer.alloc(limit - jpeg().length, 0x20)]);
    expect(atLimit.length).toBe(limit);
    expect((await send(t.lc1!, l.id, 'other', { filename: 'big.jpg', data: atLimit })).statusCode).toBe(201);

    const before = filesOnDisk().length;
    const res = await send(t.lc1!, l.id, 'other', { filename: 'toobig.jpg', data: Buffer.concat([atLimit, Buffer.from([0x20])]) });
    expect(res.statusCode).toBe(413);
    expect(errorCode(res)).toBe('FILE_TOO_LARGE');
    expect(filesOnDisk()).toHaveLength(before);
  });

  it('refuses an upload that is not a proper upload', async () => {
    const l = await lead();
    const noFile = await upload(t.lc1!, l.id, { docType: 'photo' }, []);
    expect(errorCode(noFile)).toBe('NO_FILE');

    const json = await app.inject({ method: 'POST', url: `/api/v1/leads/${l.id}/documents`, payload: { docType: 'photo' }, headers: { authorization: `Bearer ${t.lc1}` } });
    expect(errorCode(json)).toBe('NOT_MULTIPART');

    const two = await upload(t.lc1!, l.id, { docType: 'photo' }, [photo('a.jpg'), photo('b.jpg')]);
    expect(two.statusCode).toBe(400);

    expect(errorCode(await send(t.lc1!, l.id, 'selfie', photo()))).toBe('VALIDATION_FAILED');
    expect(errorCode(await upload(t.lc1!, l.id, {}, [photo()]))).toBe('VALIDATION_FAILED');
    expect(errorCode(await send(t.lc1!, l.id, 'photo', { filename: 'empty.jpg', data: Buffer.alloc(0) }))).toBe('EMPTY_FILE');
    expect(await list(t.lc1!, l.id)).toEqual([]);
  });

  it('keeps each kind of document to its place', async () => {
    const l = await lead();
    expect(errorCode(await send(t.lc1!, l.id, 'photo', { filename: 'p.pdf', data: pdf() }))).toBe('IMAGE_REQUIRED');
    expect(errorCode(await send(t.lc1!, l.id, 'signature', { filename: 's.pdf', data: pdf() }))).toBe('IMAGE_REQUIRED');
    expect((await send(t.lc1!, l.id, 'twelfth', { filename: 't.pdf', data: pdf() })).statusCode).toBe(201);

    expect(errorCode(await send(t.lc1!, l.id, 'admission', photo()))).toBe('SHORTLIST_REQUIRED');
    expect(errorCode(await send(t.lc1!, l.id, 'aadhaar', photo(), { shortlistId: randomUUID() }))).toBe('SHORTLIST_INVALID');
  });

  it('files an admission document under a shortlisted institute, and not under one from another student', async () => {
    const l = await lead();
    const other = await lead();
    const mine = (await api.call('POST', `/leads/${l.id}/shortlists`, t.lc1!, { collegeId: ids.college })).json();
    const theirs = (await api.call('POST', `/leads/${other.id}/shortlists`, t.lc1!, { collegeId: ids.college })).json();

    const ok = await send(t.lc1!, l.id, 'admission', { filename: 'offer.pdf', data: pdf() }, { shortlistId: mine.id });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().shortlist).toEqual({ id: mine.id, college: 'Alpha University' });
    expect(errorCode(await send(t.lc1!, l.id, 'admission', { filename: 'offer.pdf', data: pdf() }, { shortlistId: theirs.id }))).toBe('SHORTLIST_INVALID');
    expect(errorCode(await send(t.lc1!, l.id, 'aadhaar', photo(), { shortlistId: mine.id }))).toBe('SHORTLIST_NOT_ALLOWED');
  });

  it('allows ten files of one kind and no more', async () => {
    const l = await lead();
    for (let i = 0; i < 10; i++) expect((await send(t.lc1!, l.id, 'other', photo(`p${i}.jpg`))).statusCode).toBe(201);
    const eleventh = await send(t.lc1!, l.id, 'other', photo('p10.jpg'));
    expect(eleventh.statusCode).toBe(409);
    expect(errorCode(eleventh)).toBe('TOO_MANY_FILES');
    expect((await send(t.lc1!, l.id, 'aadhaar', photo())).statusCode).toBe(201); // another kind still has room
  });
});

// =================================================================== download

describe('opening a document', () => {
  let leadId: string;
  let docId: string;

  beforeAll(async () => {
    leadId = (await lead()).id;
    docId = (await send(t.lc1!, leadId, 'aadhaar', photo('aadhaar front.jpg'))).json().id;
  });

  it('returns exactly the bytes that were uploaded, with headers that keep it from doing anything else', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/leads/${leadId}/documents/${docId}/file`, headers: { authorization: `Bearer ${t.lc1}` } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(jpeg())).toBe(true);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toContain('aadhaar front.jpg');
    expect(Number(res.headers['content-length'])).toBe(jpeg().length);
  });

  it('can be opened through a signed link without a login header, until it expires', async () => {
    const link = await api.call('POST', `/leads/${leadId}/documents/${docId}/link`, t.lc1!);
    expect(link.statusCode).toBe(200);
    expect(link.json().url).toMatch(/^\/api\/v1\/files\/[\w-]+\.[\w-]+$/);
    expect(Date.parse(link.json().expiresAt) - Date.now()).toBeGreaterThan(200_000);

    const open = await app.inject({ method: 'GET', url: link.json().url });
    expect(open.statusCode).toBe(200);
    expect(open.rawPayload.equals(jpeg())).toBe(true);
  });

  it('refuses a link that was changed, cut short, or has run out', async () => {
    const url = (await api.call('POST', `/leads/${leadId}/documents/${docId}/link`, t.lc1!)).json().url as string;
    const token = url.split('/').pop()!;
    const [body, mac] = token.split('.');

    const tampered = `${Buffer.from(Buffer.from(body!, 'base64url').toString().replace('.jpg', '.png')).toString('base64url')}.${mac}`;
    for (const bad of [tampered, `${body}.${mac!.slice(0, -2)}AA`, body!, `${token}.extra`, 'junk']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${bad}` });
      expect(res.statusCode, bad).toBe(403);
      expect(errorCode(res)).toBe('LINK_INVALID');
    }

    // The same link, signed to expire ten seconds ago.
    const links = app.get(FileLinks);
    const real = links.verify(token);
    if (!real.ok) throw new Error('a fresh link should be valid');
    const expired = links.sign(real.claims, -10);
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${expired.token}` });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('LINK_EXPIRED');
  });

  it('is not given out for a lead the person cannot see, and a link dies with the file', async () => {
    expect((await api.call('POST', `/leads/${leadId}/documents/${docId}/link`, t.lc2!)).statusCode).toBe(404);
    expect((await get(t.lc2!, `/leads/${leadId}/documents/${docId}/file`)).statusCode).toBe(404);

    const l = await lead();
    const d = (await send(t.lc1!, l.id, 'other', photo())).json();
    const url = (await api.call('POST', `/leads/${l.id}/documents/${d.id}/link`, t.lc1!)).json().url as string;
    await api.call('DELETE', `/leads/${l.id}/documents/${d.id}`, t.lc1!);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('is not found for a document id that belongs to another lead', async () => {
    const other = await lead();
    expect((await get(t.lc1!, `/leads/${other.id}/documents/${docId}/file`)).statusCode).toBe(404);
  });
});

// ======================================================================= delete

describe('removing a document', () => {
  it('removes the record and the file, and writes it to the history', async () => {
    const l = await lead();
    const d = (await send(t.lc1!, l.id, 'signature', photo('sign.jpg'))).json();
    const path = filesOnDisk().find((p) => p.includes(l.id))!;
    expect(existsSync(path)).toBe(true);

    expect((await api.call('DELETE', `/leads/${l.id}/documents/${d.id}`, t.lc1!)).statusCode).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect(await list(t.lc1!, l.id)).toEqual([]);
    expect((await api.call('DELETE', `/leads/${l.id}/documents/${d.id}`, t.lc1!)).statusCode).toBe(404);
    const entry = (await api.call('GET', `/leads/${l.id}/activities?limit=50`, t.lc1!)).json().items.find((a: { remark: string }) => a.remark === 'Removed');
    expect(entry).toMatchObject({ type: 'document', field: 'signature', oldValue: 'sign.jpg' });
  });
});

// ======================================================================= access

describe('who may work with documents', () => {
  it('follows who can see the lead', async () => {
    const l = await lead(t.lc1!);
    const d = (await send(t.lc1!, l.id, 'aadhaar', photo())).json();

    expect((await get(t.lc2!, `/leads/${l.id}/documents`)).statusCode).toBe(404);
    expect((await send(t.lc2!, l.id, 'aadhaar', photo())).statusCode).toBe(404);
    expect((await api.call('DELETE', `/leads/${l.id}/documents/${d.id}`, t.lc2!)).statusCode).toBe(404);
    expect((await get(t.admin2!, `/leads/${l.id}/documents`)).statusCode).toBe(404);

    expect((await get(t.admin!, `/leads/${l.id}/documents`)).statusCode).toBe(200); // the Admin of the team
    expect((await send(t.admin!, l.id, 'tenth', photo())).statusCode).toBe(201);
    expect((await get(t.sa!, `/leads/${l.id}/documents/${d.id}/file`)).statusCode).toBe(200);
  });

  it('lets someone who may only read look and open, not add or remove', async () => {
    const roleId = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Doc Reader', 'all', false) RETURNING id`, [fx.tenantId])).rows[0].id;
    await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = 'lead.read'`, [fx.tenantId, roleId]);
    await fx.addUser({ name: 'docreader', roleId });
    const reader = await api.signIn('docreader');

    const l = await lead();
    const d = (await send(t.lc1!, l.id, 'aadhaar', photo())).json();
    expect((await get(reader, `/leads/${l.id}/documents`)).statusCode).toBe(200);
    expect((await get(reader, `/leads/${l.id}/documents/${d.id}/file`)).statusCode).toBe(200);
    expect((await send(reader, l.id, 'aadhaar', photo())).statusCode).toBe(403);
    expect((await api.call('DELETE', `/leads/${l.id}/documents/${d.id}`, reader)).statusCode).toBe(403);
  });

  it('needs a sign-in for everything except a signed link', async () => {
    const l = await lead();
    expect((await app.inject({ method: 'GET', url: `/api/v1/leads/${l.id}/documents` })).statusCode).toBe(401);
    const { payload, contentType } = multipart({ docType: 'photo' }, [photo()]);
    expect((await app.inject({ method: 'POST', url: `/api/v1/leads/${l.id}/documents`, payload, headers: { 'content-type': contentType } })).statusCode).toBe(401);
  });
});
