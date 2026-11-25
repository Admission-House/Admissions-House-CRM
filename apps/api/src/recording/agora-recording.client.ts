import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import {
  AGORA_BASE_URL,
  acquireBody,
  agoraRegionCode,
  basicAuth,
  filesFromServerResponse,
  type AgoraFile,
  type StorageForAgora,
} from './recording-rules.js';

/** What the client needs from the network, so a test can stand in for Agora. */
export type AgoraHttp = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Agora refused or failed a request. `code` is Agora's own number when it sent one. */
export class AgoraError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly reason: string,
  ) {
    super(`Agora answered ${httpStatus}${code !== null ? ` (code ${code})` : ''}: ${reason}`);
  }

  /** The recording is not there: never started, or already over. */
  get gone(): boolean {
    return this.httpStatus === 404;
  }
}

export interface QueryAnswer {
  /** Agora's own status number: 5 is "in progress"; 8 exited; 20 exited abnormally. */
  status: number;
  files: AgoraFile[];
}

export interface StopAnswer {
  files: AgoraFile[];
  uploadingStatus: string | null;
}

const MODE = 'mix';

/**
 * Agora Cloud Recording over its REST API. The server is the only place that ever holds the Customer ID and
 * Secret; no browser or phone sees them. Only a few answers are read, and anything else is an error.
 */
@Injectable()
export class AgoraRecordingClient {
  /** Replaced in tests. */
  http: AgoraHttp = (url, init) => fetch(url, init);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Whether everything needed to record is set: Agora's keys, the bucket, and both bucket keys. */
  configured(): boolean {
    return this.missing().length === 0;
  }

  /** The settings that are still empty, by name, for an error message that says what to fix. */
  missing(): string[] {
    const e = this.env;
    const need: [string, unknown][] = [
      ['AGORA_APP_ID', e.AGORA_APP_ID],
      ['AGORA_APP_CERTIFICATE', e.AGORA_APP_CERTIFICATE],
      ['AGORA_CUSTOMER_ID', e.AGORA_CUSTOMER_ID],
      ['AGORA_CUSTOMER_SECRET', e.AGORA_CUSTOMER_SECRET],
      ['RECORDING_S3_BUCKET', e.RECORDING_S3_BUCKET],
      ['RECORDING_S3_REGION', e.RECORDING_S3_REGION],
      ['RECORDING_S3_UPLOAD_ACCESS_KEY_ID', e.RECORDING_S3_UPLOAD_ACCESS_KEY_ID],
      ['RECORDING_S3_UPLOAD_SECRET_ACCESS_KEY', e.RECORDING_S3_UPLOAD_SECRET_ACCESS_KEY],
      ['RECORDING_S3_ACCESS_KEY_ID', e.RECORDING_S3_ACCESS_KEY_ID],
      ['RECORDING_S3_SECRET_ACCESS_KEY', e.RECORDING_S3_SECRET_ACCESS_KEY],
    ];
    const gone = need.filter(([, v]) => !v).map(([k]) => k);
    if (agoraRegionCode(e.RECORDING_S3_REGION, e.RECORDING_AGORA_REGION_CODE) === null)
      gone.push('RECORDING_AGORA_REGION_CODE');
    return gone;
  }

  /** The bucket details Agora is given to write with. */
  storageForAgora(): StorageForAgora {
    const e = this.env;
    return {
      region: agoraRegionCode(e.RECORDING_S3_REGION, e.RECORDING_AGORA_REGION_CODE)!,
      bucket: e.RECORDING_S3_BUCKET!,
      accessKey: e.RECORDING_S3_UPLOAD_ACCESS_KEY_ID!,
      secretKey: e.RECORDING_S3_UPLOAD_SECRET_ACCESS_KEY!,
    };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const url = `${AGORA_BASE_URL}/v1/apps/${this.env.AGORA_APP_ID}/cloud_recording/${path}`;
    const res = await this.http(url, {
      method,
      headers: {
        'content-type': 'application/json;charset=utf-8',
        authorization: basicAuth(this.env.AGORA_CUSTOMER_ID!, this.env.AGORA_CUSTOMER_SECRET!),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      // Not JSON: keep the status and a short piece of the text below.
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AgoraError(
        res.status,
        typeof parsed.code === 'number' ? parsed.code : null,
        String(parsed.reason ?? parsed.message ?? raw.slice(0, 200) ?? 'no reason given'),
      );
    }
    return parsed;
  }

  /** Asks Agora for a recording resource. It must be started at once (Agora: within about two seconds). */
  async acquire(channel: string, botUid: number): Promise<string> {
    const r = await this.call('POST', 'acquire', acquireBody(channel, botUid));
    if (typeof r.resourceId !== 'string')
      throw new AgoraError(200, null, 'no resource id in the answer');
    return r.resourceId;
  }

  async start(resourceId: string, body: object): Promise<string> {
    const r = await this.call('POST', `resourceid/${resourceId}/mode/${MODE}/start`, body);
    if (typeof r.sid !== 'string')
      throw new AgoraError(200, null, 'no recording id (sid) in the answer');
    return r.sid;
  }

  /** Where the recording stands, or "gone" when Agora no longer has it (never started, or over). */
  async query(resourceId: string, sid: string): Promise<QueryAnswer | 'gone'> {
    try {
      const r = await this.call('GET', `resourceid/${resourceId}/sid/${sid}/mode/${MODE}/query`);
      const sr = r.serverResponse as
        { status?: number; fileListMode?: string; fileList?: unknown } | undefined;
      return { status: Number(sr?.status ?? 0), files: filesFromServerResponse(sr) };
    } catch (err) {
      if (err instanceof AgoraError && err.gone) return 'gone';
      throw err;
    }
  }

  /** Stops the recording and waits for the upload (Agora allows about 20 seconds). "gone" means it had already ended. */
  async stop(
    resourceId: string,
    sid: string,
    channel: string,
    botUid: number,
  ): Promise<StopAnswer | 'gone'> {
    try {
      const r = await this.call('POST', `resourceid/${resourceId}/sid/${sid}/mode/${MODE}/stop`, {
        cname: channel,
        uid: String(botUid),
        clientRequest: {},
      });
      const sr = r.serverResponse as
        { uploadingStatus?: string; fileListMode?: string; fileList?: unknown } | undefined;
      return {
        files: filesFromServerResponse(sr),
        uploadingStatus: typeof sr?.uploadingStatus === 'string' ? sr.uploadingStatus : null,
      };
    } catch (err) {
      if (err instanceof AgoraError && err.gone) return 'gone';
      throw err;
    }
  }
}
