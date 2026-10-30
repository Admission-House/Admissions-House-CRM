import { Readable } from 'node:stream';
import { S3Storage } from './s3-storage.js';

const T = '01a17d38-4b02-7ec8-915c-151dcbd15ee3';
const KEY = `${T}/${T}/${T}.jpg`;

function fake() {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let reply: unknown = {};
  return {
    sent,
    reply: (r: unknown) => (reply = r),
    client: {
      send: (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: c.constructor.name, input: c.input });
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(reply);
      },
    },
  };
}

describe('S3Storage', () => {
  it('writes, reads and deletes in the configured bucket', async () => {
    const f = fake();
    const s = new S3Storage(f.client, 'bkt');
    await s.put(KEY, Buffer.from('abc'));
    f.reply({ Body: Readable.from(['abc']), ContentLength: 3 });
    const got = await s.get(KEY);
    expect(got?.size).toBe(3);
    await s.delete(KEY);
    expect(f.sent.map((c) => c.name)).toEqual(['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']);
    expect(f.sent.every((c) => c.input.Bucket === 'bkt' && c.input.Key === KEY)).toBe(true);
  });

  it('treats a missing object as null and passes other errors on', async () => {
    const f = fake();
    const s = new S3Storage(f.client, 'bkt');
    f.reply(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
    expect(await s.get(KEY)).toBeNull();
    f.reply(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 404 } }));
    expect(await s.get(KEY)).toBeNull();
    f.reply(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(s.get(KEY)).rejects.toThrow('denied');
  });

  it('refuses any key the server did not make', async () => {
    const s = new S3Storage(fake().client, 'bkt');
    for (const bad of ['../../etc/passwd', `${T}/x.jpg`, `${KEY}/../a`, '']) {
      await expect(s.put(bad, Buffer.alloc(1))).rejects.toThrow('not a valid storage key');
      await expect(s.get(bad)).rejects.toThrow('not a valid storage key');
      await expect(s.delete(bad)).rejects.toThrow('not a valid storage key');
    }
  });
});
