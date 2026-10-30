import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MasterImportService } from './master-import.service.js';
import { parseFieldMap, tableFromJson } from './college-api-rules.js';

export interface CollegeApiStatus {
  configured: boolean;
  /** The provider's host only, never the full address or the key. */
  host: string | null;
  itemsPath: string | null;
  /** How each of our fields is read from the response, when the company mapped any. */
  fieldMap: Record<string, string>;
}

/**
 * Pulls colleges, courses and fees from the college data provider's API (set in the environment) and
 * feeds them through the same preview-then-import path as a spreadsheet. Nothing is saved by a
 * preview. The provider's address and key live only in the environment.
 */
@Injectable()
export class CollegeApiService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly imports: MasterImportService,
  ) {}

  status(): CollegeApiStatus {
    const url = this.env.COLLEGE_API_URL;
    return {
      configured: Boolean(url),
      host: url ? new URL(url).host : null,
      itemsPath: this.env.COLLEGE_API_ITEMS_PATH ?? null,
      fieldMap: parseFieldMap(this.env.COLLEGE_API_FIELD_MAP),
    };
  }

  async preview(auth: AuthContext) {
    return this.imports.previewTable(auth, await this.fetchTable());
  }

  async sync(auth: AuthContext) {
    return this.imports.applyTable(auth, await this.fetchTable(), 'college-api');
  }

  private async fetchTable() {
    const url = this.env.COLLEGE_API_URL;
    if (!url) throw new AppError('COLLEGE_API_NOT_SET', 'The college data connection is not set up yet. Add COLLEGE_API_URL and COLLEGE_API_KEY to the environment.', 409);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.env.COLLEGE_API_KEY) {
      const scheme = this.env.COLLEGE_API_AUTH_SCHEME;
      headers[this.env.COLLEGE_API_AUTH_HEADER] = scheme ? `${scheme} ${this.env.COLLEGE_API_KEY}` : this.env.COLLEGE_API_KEY;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(this.env.COLLEGE_API_TIMEOUT_SEC * 1000), redirect: 'error' });
    } catch {
      throw new AppError('COLLEGE_API_UNREACHABLE', 'Could not reach the college data provider. Try again in a moment.', 502);
    }
    if (res.status === 401 || res.status === 403) throw new AppError('COLLEGE_API_REFUSED', 'The college data provider refused the key. Check COLLEGE_API_KEY.', 502);
    if (!res.ok) throw new AppError('COLLEGE_API_FAILED', `The college data provider answered with an error (${res.status}).`, 502);

    const text = await this.readLimited(res);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AppError('COLLEGE_API_BAD_RESPONSE', 'The college data provider did not send JSON.', 502);
    }
    try {
      return tableFromJson(body, { itemsPath: this.env.COLLEGE_API_ITEMS_PATH, fieldMap: parseFieldMap(this.env.COLLEGE_API_FIELD_MAP) });
    } catch (err) {
      throw new AppError('COLLEGE_API_BAD_RESPONSE', err instanceof Error ? err.message : 'The response could not be read.', 502);
    }
  }

  /** Reads the body but gives up past the size limit, so a wrong address cannot fill memory. */
  private async readLimited(res: Response): Promise<string> {
    const max = this.env.COLLEGE_API_MAX_BYTES;
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new AppError('COLLEGE_API_TOO_BIG', 'The college data provider sent more data than is allowed.', 502);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
