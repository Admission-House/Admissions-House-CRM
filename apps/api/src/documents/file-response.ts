import { StreamableFile } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';

/**
 * Sends a stored file back. The type comes from what the file was found to be when it was uploaded.
 * Headers keep it from doing anything but being shown or saved: no guessing of the type, no
 * scripts, nothing kept by shared caches.
 */
export function sendFile(reply: FastifyReply, file: { stream: Readable; size: number }, type: string, name: string): StreamableFile {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  void reply.header('content-type', type);
  void reply.header('content-length', file.size);
  void reply.header('content-disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  void reply.header('cache-control', 'private, no-store');
  void reply.header('x-content-type-options', 'nosniff');
  void reply.header('content-security-policy', "default-src 'none'; sandbox");
  return new StreamableFile(file.stream);
}
