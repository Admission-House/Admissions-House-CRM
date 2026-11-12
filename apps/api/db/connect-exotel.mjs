// Connects a company to Exotel using settings from the environment (.env), so the credentials are never
// typed into a screen or sent in a chat. Build the API first (pnpm build), then:
//
//   node --env-file=.env db/connect-exotel.mjs <company-short-name>
//
// Needs in .env: EXOTEL_ACCOUNT_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLER_ID, PUBLIC_API_URL
// (and optionally EXOTEL_HOST, EXOTEL_RECORD, EXOTEL_RECORDING_HOSTS). See ops/production.env.example.
//
// The credentials are stored encrypted in the database. The address to give Exotel contains a secret
// key, so it is written to .secrets/telephony-<company>.txt (readable only by you) and never printed.

import 'reflect-metadata';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slug = process.argv[2];
if (!slug || !process.env.MIGRATOR_DATABASE_URL || !process.env.DATA_ENCRYPTION_KEY) {
  console.error('usage: node --env-file=.env db/connect-exotel.mjs <company-short-name>');
  console.error('MIGRATOR_DATABASE_URL and DATA_ENCRYPTION_KEY must be set in .env');
  process.exit(1);
}

let connectExotelFromEnv;
let SecretBox;
try {
  ({ connectExotelFromEnv } = await import('../dist/telephony/env-connection.js'));
  ({ SecretBox } = await import('../dist/crypto/secret-box.js'));
} catch {
  console.error('The API is not built. Run "pnpm build" in apps/api first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
await client.connect();
try {
  const result = await connectExotelFromEnv(client, new SecretBox({ DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY }), slug, process.env);
  const dir = join(root, '.secrets');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `telephony-${slug}.txt`);
  await writeFile(
    file,
    [
      `Exotel connection for "${slug}" (keep private)`,
      '',
      'Address for Exotel (incoming and missed calls: the Passthru applet, method GET):',
      result.callbackUrl,
      '',
      'Outgoing calls need nothing in the Exotel dashboard: the CRM sends this address with every call.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await chmod(file, 0o600).catch(() => undefined);
  console.log(`${result.created ? 'Exotel connected' : 'Exotel connection updated'} for "${slug}".`);
  console.log(result.keptKey ? 'The webhook key is unchanged, so the address already given to Exotel still works.' : 'A new webhook key was made.');
  console.log(`The address for Exotel is in ${file}`);
} catch (err) {
  console.error(`Nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
