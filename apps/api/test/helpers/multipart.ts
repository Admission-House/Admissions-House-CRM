import { randomBytes } from 'node:crypto';

export interface UploadFile {
  /** Name of the form field; the API expects "file". */
  field?: string;
  filename: string;
  /** The type the browser would claim. The server must not trust it. */
  type?: string;
  data: Buffer;
}

/** Builds a multipart/form-data body by hand, the way a browser or the mobile app sends it. */
export function multipart(fields: Record<string, string>, files: UploadFile[] = []): { payload: Buffer; contentType: string } {
  const boundary = `----test${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      f.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
