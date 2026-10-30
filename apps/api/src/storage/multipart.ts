import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';

export interface MultipartForm {
  fields: Record<string, string>;
  file?: { filename: string; data: Buffer };
}

export const tooLarge = (bytes: number) => new AppError('FILE_TOO_LARGE', `The file is larger than ${Math.round(bytes / 1_048_576)} MB`, 413);

/** Reads a multipart upload with at most one file. The size and part limits are set where multipart is registered. */
export async function readForm(req: FastifyRequest, maxBytes: number): Promise<MultipartForm> {
  if (!req.isMultipart()) throw AppError.badRequest('NOT_MULTIPART', 'Send the file as multipart/form-data');
  const form: MultipartForm = { fields: {} };
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (form.file) throw AppError.badRequest('ONE_FILE_ONLY', 'Send one file at a time');
        form.file = { filename: part.filename, data: await part.toBuffer() };
      } else {
        form.fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(maxBytes);
    if (code?.startsWith('FST_') && code.endsWith('_LIMIT')) throw AppError.badRequest('TOO_MANY_PARTS', 'Send one file and its details only');
    throw err;
  }
  return form;
}
