import { createServer, Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { VirusScanner } from './virus-scanner.service.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A stand-in for clamd: reads the INSTREAM framing and answers with the given text. */
function fakeClamd(answer: (data: Buffer) => string | null): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        const head = 'zINSTREAM\0'.length;
        if (buf.length < head) return;
        let pos = head;
        const parts: Buffer[] = [];
        while (buf.length >= pos + 4) {
          const len = buf.readUInt32BE(pos);
          if (len === 0) {
            const reply = answer(Buffer.concat(parts));
            if (reply !== null) socket.end(`${reply}\0`);
            else socket.destroy();
            return;
          }
          if (buf.length < pos + 4 + len) return;
          parts.push(buf.subarray(pos + 4, pos + 4 + len));
          pos += 4 + len;
        }
      });
    }).listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
}
const scanner = (port?: number) => new VirusScanner({ CLAMAV_HOST: port ? '127.0.0.1' : undefined, CLAMAV_PORT: port ?? 3310, CLAMAV_TIMEOUT_MS: 2000 });

describe('virus scanner', () => {
  it('does nothing when it is not configured', async () => {
    await expect(scanner().assertClean(Buffer.from('x'))).resolves.toBeUndefined();
  });

  it('sends the whole file in chunks and accepts a clean answer', async () => {
    let seen = 0;
    const port = await fakeClamd((d) => { seen = d.length; return 'stream: OK'; });
    await scanner(port).assertClean(Buffer.alloc(200_000, 1));
    expect(seen).toBe(200_000);
  });

  it('refuses a file clamd flags', async () => {
    const port = await fakeClamd(() => 'stream: Eicar-Signature FOUND');
    await expect(scanner(port).assertClean(Buffer.from('x'))).rejects.toMatchObject({ code: 'VIRUS_FOUND' });
  });

  it('refuses the upload when the scanner cannot be reached or gives no answer', async () => {
    await expect(scanner(1).assertClean(Buffer.from('x'))).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
    const port = await fakeClamd(() => null);
    await expect(scanner(port).assertClean(Buffer.from('x'))).rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' });
  });
});
