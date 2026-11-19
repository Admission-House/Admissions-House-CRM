import { BlobStorage, type BlobLike } from './blob-storage.js';

const T = '01a17d38-4b02-7ec8-915c-151dcbd15ee3';
const KEY = `${T}/${T}/${T}.pdf`;

function fake() {
  const calls: { op: string; key: string; options: Record<string, unknown> }[] = [];
  let stored: Buffer | null = null;
  let failDelete: Error | null = null;
  const client: BlobLike = {
    put: async (key, data, options) => { calls.push({ op: 'put', key, options }); stored = data; },
    get: async (key, options) => {
      calls.push({ op: 'get', key, options });
      if (!stored) return null;
      const body = stored;
      return { statusCode: 200, stream: new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array(body)); c.close(); } }), blob: { size: body.length } };
    },
    del: async (key, options) => { calls.push({ op: 'del', key, options }); if (failDelete) throw failDelete; stored = null; },
  };
  return { client, calls, failDeleteWith: (e: Error) => (failDelete = e) };
}

describe('BlobStorage', () => {
  it('writes a private file under its own key without overwriting, reads it back and deletes it', async () => {
    const f = fake();
    const s = new BlobStorage(f.client);
    await s.put(KEY, Buffer.from('hello'));
    expect(f.calls[0]).toMatchObject({ op: 'put', key: KEY, options: { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/pdf' } });
    const got = await s.get(KEY);
    expect(got!.size).toBe(5);
    const chunks: Buffer[] = [];
    for await (const c of got!.stream) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await s.delete(KEY);
    expect(await s.get(KEY)).toBeNull();
  });

  it('refuses a key that is not one the server made, before it reaches the store', async () => {
    const f = fake();
    const s = new BlobStorage(f.client);
    for (const bad of ['../../etc/passwd', `${T}/${T}/${T}.exe`, 'x/y/z.pdf']) {
      await expect(s.put(bad, Buffer.from('x'))).rejects.toThrow('not a valid storage key');
      await expect(s.get(bad)).rejects.toThrow('not a valid storage key');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('treats a file that is already gone as deleted, and passes any other failure on', async () => {
    const f = fake();
    const s = new BlobStorage(f.client);
    const gone = new Error('missing');
    gone.name = 'BlobNotFoundError';
    f.failDeleteWith(gone);
    await expect(s.delete(KEY)).resolves.toBeUndefined();
    f.failDeleteWith(new Error('store down'));
    await expect(s.delete(KEY)).rejects.toThrow('store down');
  });
});
