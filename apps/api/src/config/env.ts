import { z } from 'zod';
import { parseFieldMap } from '../masters/college-api-rules.js';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Connection used by the API. It must be the restricted role (ah_app), never the owner. */
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  /** Longest a single statement may run, in milliseconds. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  /** Browser origins allowed to call the API, comma separated. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /**
   * How many reverse proxies sit in front of the API. The real client IP, which the office
   * check depends on, is only trusted from that many hops. "0" means no proxy: use the socket IP.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Largest request body in bytes. */
  BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),

  /** Signs access tokens. At least 32 characters; keep it out of the repository. */
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Encrypts secrets kept in the database, such as telephony credentials. 64 hex characters; keep it out of the repository and back it up: without it those secrets cannot be read. */
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 hex characters (32 bytes)'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  /** A session ends this long after sign-in, whatever the activity. */
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(72).default(12),

  /** Wrong passwords in a row before an account is locked, and for how long. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /** Sign-in attempts allowed from one address in ten minutes. */
  LOGIN_IP_MAX_ATTEMPTS: z.coerce.number().int().min(5).max(500).default(30),
  /** A GPS reading less precise than this (in metres) is not accepted for the office check. */
  GPS_MAX_ACCURACY_M: z.coerce.number().int().min(10).max(1000).default(150),

  /** How often the background sweep ends idle sessions, in seconds. 0 turns it off. */
  SWEEP_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(60),

  /** How often events that failed to become leads are tried again, in seconds. 0 turns it off. */
  INTAKE_RETRY_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(60),

  /** How often follow-up reminders are sent, in seconds. 0 turns it off. */
  FOLLOWUP_REMINDER_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(60),
  IMPORT_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(30),

  /** Where uploaded files are kept. "local" is a folder on the server; a cloud store is added behind the same interface. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** For STORAGE_DRIVER=s3: any S3-compatible store (AWS, MinIO, Cloudflare R2, DigitalOcean Spaces). */
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  /** Leave empty for AWS; set for other providers, for example https://<account>.r2.cloudflarestorage.com */
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** Largest upload, in bytes. 2 MB, as agreed for documents. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(26_214_400).default(2_097_152),
  /** Largest call recording that will be downloaded from the provider, in bytes. */
  RECORDING_MAX_BYTES: z.coerce.number().int().min(1024).max(209_715_200).default(52_428_800),
  /** How often waiting recordings are downloaded, in seconds. 0 turns it off. */
  RECORDING_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(30),
  /** Allow plain http, other ports and private addresses for recordings. For tests and local development only. */
  RECORDING_ALLOW_INSECURE: bool,
  /** "log" keeps mail in memory and writes nothing out (development and tests); "smtp" sends it. Production must use smtp. */
  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true for port 465 (TLS from the start); false for STARTTLS on 587. */
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** The From address of every email, for example "Admissions House <no-reply@admissionshouse.com>". */
  MAIL_FROM: z.string().default('Admissions House CRM <no-reply@localhost>'),
  /** Where the web CRM lives, used to build links in emails. */
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /** How long a password reset link works, in minutes. */
  RESET_LINK_TTL_MIN: z.coerce.number().int().min(5).max(1440).default(30),
  /** How long a download link stays valid, in seconds. */
  FILE_LINK_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  /** The college data provider's list endpoint. Leave out until the provider is chosen. */
  COLLEGE_API_URL: z.string().url().optional(),
  COLLEGE_API_KEY: z.string().optional(),
  /** The header that carries the key, and the word before it ("Bearer"). An empty scheme sends the key alone (for "x-api-key"). */
  COLLEGE_API_AUTH_HEADER: z.string().min(1).default('Authorization'),
  COLLEGE_API_AUTH_SCHEME: z.string().default('Bearer'),
  /** Where the list sits in the response, as a dotted path such as "data.colleges". Empty when the response is the list. */
  COLLEGE_API_ITEMS_PATH: z.string().optional(),
  /** JSON saying where each of our fields is in each item, for example {"college":"name","annualFee":"fees.annual"}. */
  COLLEGE_API_FIELD_MAP: z.string().optional(),
  COLLEGE_API_TIMEOUT_SEC: z.coerce.number().int().min(1).max(120).default(30),
  COLLEGE_API_MAX_BYTES: z.coerce.number().int().min(1024).max(52_428_800).default(10_485_760),

  ENABLE_API_DOCS: bool,
});

export type Env = z.infer<typeof schema>;

/** Reads and checks the environment once at start-up. A bad value stops the process with a clear message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && /\/\/(postgres|admin|root)[:@]/.test(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must use the restricted application role, not an owner or admin account');
  }
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3');
  if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_HOST) throw new Error('SMTP_HOST is required when MAIL_DRIVER=smtp');
  if (env.COLLEGE_API_URL) {
    if (env.NODE_ENV === 'production' && !env.COLLEGE_API_URL.startsWith('https://')) throw new Error('COLLEGE_API_URL must use https in production');
    parseFieldMap(env.COLLEGE_API_FIELD_MAP);
  }
  if (env.NODE_ENV === 'production' && env.MAIL_DRIVER !== 'smtp') throw new Error('MAIL_DRIVER must be smtp in production, or password reset emails are never delivered');
  return env;
}
