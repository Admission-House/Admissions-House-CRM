// Applies db/migrations/*.sql in filename order, once each, inside one transaction per file.
// Run with: node --env-file=.env db/migrate.mjs
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.MIGRATOR_DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!url || !appPassword) {
  console.error('MIGRATOR_DATABASE_URL and APP_DB_PASSWORD must be set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // One runner at a time, even if two deploys start together.
  await client.query('SELECT pg_advisory_lock(727001)');

  // The application role: can read and write data, but owns nothing and cannot bypass RLS.
  const { rows } = await client.query(
    `SELECT format(
       'DO $r$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %L) THEN
            CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
          ALTER ROLE %I PASSWORD %L;
        END $r$', 'ah_app', 'ah_app', 'ah_app', $1::text) AS sql`,
    [appPassword],
  );
  await client.query(rows[0].sql);

  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = new Map(
    (await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [
      r.version,
      r.checksum,
    ]),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const known = applied.get(file);
    if (known) {
      if (known !== checksum) throw new Error(`${file} was changed after it was applied`);
      continue;
    }
    console.log(`applying ${file}`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${file} failed: ${err.message}`);
    }
  }
  console.log(count ? `done, ${count} applied` : 'database is up to date');
} finally {
  await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
  await client.end();
}
