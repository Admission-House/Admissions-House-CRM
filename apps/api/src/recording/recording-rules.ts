/**
 * The facts about Agora Cloud Recording, kept apart from the network so they can be tested on their own.
 * Every number here comes from Agora's documentation (docs.agora.io, Cloud Recording: REST API, region-vendor,
 * notifications); where something is a reading of a name rather than a stated fact, it says so.
 */

export type RecordingStatus =
  | 'pending'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'processing'
  | 'available'
  | 'failed'
  | 'expired';

/** A recording that still needs looking after. */
export const LIVE_STATUSES: readonly RecordingStatus[] = [
  'pending',
  'starting',
  'recording',
  'stopping',
  'processing',
];
export const isLive = (s: RecordingStatus): boolean => LIVE_STATUSES.includes(s);

/** What a session shows about its recording: switched off, wanted but not possible, or the state of the latest one. */
export type SessionRecordingStatus = 'off' | 'unavailable' | RecordingStatus;

/**
 * What to show for a session that has no recording yet. One answer for every screen and filter: waiting for it to start,
 * wanted but the server cannot record ("unavailable"), or not recorded at all.
 */
export function statusBeforeAnyRecording(session: {
  recording_enabled: boolean;
  recording_unavailable?: boolean;
}): SessionRecordingStatus {
  return session.recording_enabled
    ? 'pending'
    : session.recording_unavailable
      ? 'unavailable'
      : 'off';
}

/** Agora's base address for Cloud Recording. HTTPS only. */
export const AGORA_BASE_URL = 'https://api.sd-rtn.com';

/**
 * Agora's number for each Amazon S3 region (Agora docs, "region-vendor", vendor 1). The docs give the names in
 * Agora's style (AP_SOUTH_1); matching them to AWS names (ap-south-1) is a reading of the names, not a stated
 * mapping, so the first real recording must confirm it. RECORDING_AGORA_REGION_CODE overrides it.
 */
const REGION_CODES: Record<string, number> = {
  'us-east-1': 0,
  'us-east-2': 1,
  'us-west-1': 2,
  'us-west-2': 3,
  'eu-west-1': 4,
  'eu-west-2': 5,
  'eu-west-3': 6,
  'eu-central-1': 7,
  'ap-southeast-1': 8,
  'ap-southeast-2': 9,
  'ap-northeast-1': 10,
  'ap-northeast-2': 11,
  'sa-east-1': 12,
  'ca-central-1': 13,
  'ap-south-1': 14,
  'cn-north-1': 15,
  'cn-northwest-1': 16,
  'af-south-1': 18,
  'ap-east-1': 19,
  'ap-northeast-3': 20,
  'eu-north-1': 21,
  'me-south-1': 22,
  'ap-southeast-3': 24,
  'eu-south-1': 25,
};

export function agoraRegionCode(
  awsRegion: string | undefined,
  override: number | undefined,
): number | null {
  if (override !== undefined) return override;
  if (!awsRegion) return null;
  return REGION_CODES[awsRegion.toLowerCase()] ?? null;
}

/** The HTTP Basic header Agora wants: base64 of "customerId:customerSecret". */
export const basicAuth = (customerId: string, customerSecret: string): string =>
  `Basic ${Buffer.from(`${customerId}:${customerSecret}`).toString('base64')}`;

/**
 * Where Agora writes a session's files in the bucket. Agora allows only letters and digits in each part of
 * the prefix, so the ids are written without dashes. One folder per company and per session.
 */
export function filePrefixFor(tenantId: string, sessionId: string): string {
  return `rec/${tenantId.replace(/-/g, '')}/${sessionId.replace(/-/g, '')}`;
}

export interface StorageForAgora {
  region: number;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/** The body of the "acquire" call. One resource is asked for per recording; it must be started within moments. */
export function acquireBody(channel: string, botUid: number) {
  return {
    cname: channel,
    uid: String(botUid),
    clientRequest: { scene: 0, resourceExpiredHour: 24 },
  };
}

/**
 * The body of the "start" call, for a composite (mixed) recording: everyone in one file. A voice session is
 * recorded as sound only; a video session as sound and picture at a size inside Agora's HD class. The file
 * types are HLS and MP4, because Agora's documentation says MP4 comes only together with HLS.
 */
export function startBody(p: {
  channel: string;
  botUid: number;
  token: string;
  voice: boolean;
  prefix: string;
  storage: StorageForAgora;
  maxIdleSeconds: number;
}) {
  return {
    cname: p.channel,
    uid: String(p.botUid),
    clientRequest: {
      token: p.token,
      recordingConfig: {
        channelType: 0, // the app joins in Agora's "communication" mode
        streamTypes: p.voice ? 0 : 2,
        maxIdleTime: p.maxIdleSeconds,
        subscribeAudioUids: ['#allstream#'],
        ...(p.voice
          ? {}
          : {
              subscribeVideoUids: ['#allstream#'],
              transcodingConfig: {
                width: 640,
                height: 360,
                fps: 15,
                bitrate: 500,
                mixedVideoLayout: 1,
                backgroundColor: '#000000',
              },
            }),
      },
      recordingFileConfig: { avFileType: ['hls', 'mp4'] },
      storageConfig: {
        vendor: 1,
        region: p.storage.region,
        bucket: p.storage.bucket,
        accessKey: p.storage.accessKey,
        secretKey: p.storage.secretKey,
        fileNamePrefix: p.prefix.split('/'),
      },
    },
  };
}

export type FileKind = 'audio' | 'video' | 'audio_and_video';
export type FileFormat = 'mp4' | 'mp3' | 'm3u8' | 'ts';

/** What a file in the bucket is, from its name. Anything that is not a recording output is ignored. */
export function classifyFile(name: string): { format: FileFormat; playable: boolean } | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'mp3') return { format: ext, playable: true };
  if (ext === 'm3u8') return { format: 'm3u8', playable: false };
  if (ext === 'ts') return { format: 'ts', playable: false };
  return null;
}

export interface AgoraFile {
  fileName: string;
  trackType?: string;
}

/**
 * The files Agora reports in a query or stop answer. With HLS and MP4 the list is an array of objects
 * ("json" mode); with HLS alone it is the name of the M3U8 file ("string" mode).
 */
export function filesFromServerResponse(
  r: { fileListMode?: string; fileList?: unknown } | undefined,
): AgoraFile[] {
  if (!r?.fileList) return [];
  if (typeof r.fileList === 'string') return [{ fileName: r.fileList }];
  if (!Array.isArray(r.fileList)) return [];
  return r.fileList.flatMap((f): AgoraFile[] => {
    const x = f as { fileName?: unknown; trackType?: unknown };
    return typeof x.fileName === 'string'
      ? [
          {
            fileName: x.fileName,
            trackType: typeof x.trackType === 'string' ? x.trackType : undefined,
          },
        ]
      : [];
  });
}

/** Whether a file is sound only, picture only, or both, from what Agora said and what the session was. */
export function kindOf(file: AgoraFile | undefined, voice: boolean): FileKind {
  const t = file?.trackType;
  if (t === 'audio' || t === 'video' || t === 'audio_and_video') return t;
  return voice ? 'audio' : 'audio_and_video';
}

/** The numbers of Agora's notices that matter here (docs: "receive notifications", event types). */
export const EVENT = {
  ERROR: 1,
  WARNING: 2,
  STATUS: 3,
  FILE_INFOS: 4,
  SESSION_EXIT: 11,
  FAILOVER: 12,
  UPLOAD_STARTED: 30,
  UPLOADED: 31,
  BACKUPED: 32,
  RECORDER_LEAVE: 41,
  DOWNLOAD_FAILED: 90,
} as const;

export type NoticeAction =
  | { kind: 'check_files' }
  | { kind: 'ended'; abnormal: boolean }
  | { kind: 'failed'; reason: string }
  | { kind: 'note'; text: string }
  | { kind: 'ignore' };

/** What a notice from Agora means for us. Unknown notices are ignored, never guessed at. */
export function actionForNotice(
  eventType: number,
  details: Record<string, unknown> | undefined,
): NoticeAction {
  switch (eventType) {
    case EVENT.UPLOADED:
    case EVENT.BACKUPED:
      return { kind: 'check_files' };
    case EVENT.SESSION_EXIT:
      return { kind: 'ended', abnormal: details?.exitStatus === 1 };
    case EVENT.ERROR: {
      const level = Number(details?.errorLevel ?? 0);
      return level >= 5
        ? {
            kind: 'failed',
            reason: `Agora reported a fatal recording error${details?.msg ? `: ${String(details.msg).slice(0, 200)}` : ''}`,
          }
        : { kind: 'note', text: `error level ${level}` };
    }
    case EVENT.DOWNLOAD_FAILED:
      return { kind: 'failed', reason: 'Agora could not write the recording to the bucket' };
    case EVENT.WARNING:
      return { kind: 'note', text: 'Agora warning' };
    default:
      return { kind: 'ignore' };
  }
}

/** The status of a recording the session's outcome says should be reported to the host. */
export const REASON = {
  notSetUp: 'Recording is not set up on the server, so this session is not being recorded.',
  endedEarly: 'The session ended before the recording could start.',
  startFailed: 'Agora could not start the recording.',
  startNotConfirmed: 'The recording did not confirm that it started.',
  noFile: 'The recording stopped but no playable file was found in the storage bucket.',
  abnormalExit: 'The recorder left the channel unexpectedly.',
} as const;
