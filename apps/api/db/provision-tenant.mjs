// Creates a new company (tenant) with its standard roles, configuration, branch, Super Admins and
// a lead-intake API key for its website. Everything happens in one transaction: either the whole
// company exists afterwards or nothing does.
//
//   node --env-file=.env db/provision-tenant.mjs db/tenants/<company>.json
//
// Passwords and the API key are written to .secrets/<slug>.txt and never printed.

import argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as defaults from './defaults.mjs';
import * as perms from './permission-sets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2];
if (!configPath || !process.env.MIGRATOR_DATABASE_URL) {
  console.error('usage: node --env-file=.env db/provision-tenant.mjs <config.json>');
  process.exit(1);
}
const cfg = JSON.parse(await readFile(configPath, 'utf8'));
const timezone = cfg.timezone ?? 'Asia/Kolkata';

// Letters and digits without look-alikes (no 0/O, 1/l/I), so a password can be read out loud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const password = (len = 16) =>
  Array.from({ length: len }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
await client.connect();
const q = (text, params) => client.query(text, params);
const one = async (text, params) => (await q(text, params)).rows[0];

const credentials = [];
try {
  await q('BEGIN');

  if ((await q('SELECT 1 FROM tenants WHERE slug = $1', [cfg.slug])).rowCount) {
    throw new Error(`a company with slug "${cfg.slug}" already exists; nothing was changed`);
  }

  const tenant = await one(
    `INSERT INTO tenants (name, slug, timezone, settings) VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      cfg.name,
      cfg.slug,
      timezone,
      JSON.stringify({
        product_name: cfg.productName ?? `${cfg.name} CRM`,
        contact_email: cfg.contactEmail,
      }),
    ],
  );
  const tid = tenant.id;
  await q(`SELECT set_config('app.tenant_id', $1, true)`, [tid]);

  // Roles and their permissions.
  const roleIds = {};
  for (const r of defaults.ROLES) {
    roleIds[r.systemKey] = (
      await one(
        `INSERT INTO roles (tenant_id, name, system_key, data_scope, requires_office, is_system)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [tid, r.name, r.systemKey, r.dataScope, r.requiresOffice],
      )
    ).id;
  }
  const sets = { super_admin: perms.SUPER_ADMIN, admin: perms.ADMIN, counsellor: perms.COUNSELLOR };
  for (const [key, set] of Object.entries(sets)) {
    const all = set === 'ALL';
    const res = await q(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       SELECT $1, $2, p.id FROM permissions p WHERE $3 OR p.code = ANY($4::text[])`,
      [tid, roleIds[key], all, all ? [] : set],
    );
    if (!all && res.rowCount !== set.length) {
      throw new Error(
        `role ${key}: expected ${set.length} permissions, found ${res.rowCount}; check permission-sets.mjs`,
      );
    }
  }

  // Lead configuration.
  let order = 0;
  for (const s of defaults.LEAD_STATUSES) {
    await q(
      `INSERT INTO lead_statuses (tenant_id, name, queue, is_open, requires_followup, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tid, s.name, s.queue, s.open, s.followup, order++],
    );
  }
  for (const name of defaults.STREAMS) await q(`INSERT INTO streams (tenant_id, name) VALUES ($1, $2)`, [tid, name]);
  const sourceIds = {};
  for (const s of defaults.LEAD_SOURCES) {
    sourceIds[s.name] = (
      await one(
        `INSERT INTO lead_sources (tenant_id, name, channel_type) VALUES ($1, $2, $3) RETURNING id`,
        [tid, s.name, s.channel],
      )
    ).id;
  }
  await q(
    `INSERT INTO lead_policies (tenant_id, duplicate_action, auto_assign) VALUES ($1, $2, $3)`,
    [tid, defaults.LEAD_POLICY.duplicateAction, defaults.LEAD_POLICY.autoAssign],
  );

  // Attendance, breaks and leave.
  const a = defaults.ATTENDANCE_SETTINGS;
  await q(
    `INSERT INTO attendance_settings
       (tenant_id, effective_from, shift_start, shift_end, grace_minutes, half_day_below_hours,
        idle_timeout_min, weekly_off_days)
     VALUES ($1, (now() AT TIME ZONE $2)::date, $3, $4, $5, $6, $7, $8)`,
    [
      tid,
      timezone,
      a.shiftStart,
      a.shiftEnd,
      a.graceMinutes,
      a.halfDayBelowHours,
      a.idleTimeoutMin,
      a.weeklyOffDays,
    ],
  );
  for (const b of defaults.BREAK_TYPES) {
    await q(`INSERT INTO break_types (tenant_id, name, allowed_minutes) VALUES ($1, $2, $3)`, [
      tid,
      b.name,
      b.minutes,
    ]);
  }
  const leaveTypes = [];
  for (const l of defaults.LEAVE_TYPES) {
    leaveTypes.push(
      await one(
        `INSERT INTO leave_types (tenant_id, name, is_paid, yearly_quota)
         VALUES ($1, $2, $3, $4) RETURNING id, yearly_quota`,
        [tid, l.name, l.paid, l.quota],
      ),
    );
  }

  // Branch. Its map position and allowed networks are set later with the Detect button.
  await q(`INSERT INTO branches (tenant_id, name, address) VALUES ($1, $2, $3)`, [
    tid,
    cfg.branch.name,
    cfg.branch.address,
  ]);

  // Super Admins.
  const userIds = [];
  for (const u of cfg.superAdmins) {
    const pw = password();
    const hash = await argon2.hash(pw, { type: argon2.argon2id });
    const row = await one(
      `INSERT INTO users (tenant_id, role_id, name, email, password_hash, joined_on, must_change_password)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, true) RETURNING id`,
      [tid, roleIds.super_admin, u.name, u.email, hash],
    );
    userIds.push(row.id);
    await q(`INSERT INTO user_profiles (tenant_id, user_id) VALUES ($1, $2)`, [tid, row.id]);
    for (const lt of leaveTypes) {
      await q(
        `INSERT INTO leave_balances (tenant_id, user_id, leave_type_id, year, balance)
         VALUES ($1, $2, $3, EXTRACT(YEAR FROM now())::int, $4)`,
        [tid, row.id, lt.id, lt.yearly_quota],
      );
    }
    credentials.push(`${u.name.padEnd(10)} ${u.email.padEnd(40)} ${pw}`);
  }

  // Intake key for the website. Only the hash is stored; the key goes to the secrets file once.
  const apiKey = `ahk_${randomBytes(32).toString('base64url')}`;
  await q(
    `INSERT INTO api_keys (tenant_id, source_id, name, key_prefix, key_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tid,
      sourceIds['Website'],
      'Website lead form',
      apiKey.slice(0, 8),
      createHash('sha256').update(apiKey).digest('hex'),
      userIds[0],
    ],
  );

  await q(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, entity, entity_id, after)
     VALUES ($1, NULL, 'tenant.provisioned', 'tenant', $1, $2)`,
    [tid, JSON.stringify({ slug: cfg.slug, super_admins: cfg.superAdmins.length })],
  );

  await q('COMMIT');

  const dir = process.env.SECRETS_DIR ?? join(root, '.secrets');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${cfg.slug}.txt`);
  await writeFile(
    file,
    [
      `${cfg.name}: first-time credentials (keep private, delete after sharing)`,
      `Company slug: ${cfg.slug}`,
      '',
      'Super Admins (each must change the password on first sign-in):',
      ...credentials,
      '',
      'Website lead intake key (put in the website as CRM_WEBHOOK_SECRET):',
      apiKey,
      '',
    ].join('\n'),
  );
  console.log(`company "${cfg.name}" created (${tid})`);
  console.log(
    `${cfg.superAdmins.length} Super Admins, ${defaults.LEAD_STATUSES.length} statuses, ${defaults.LEAD_SOURCES.length} sources`,
  );
  console.log(`credentials saved to ${file}`);
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error('failed, nothing was saved:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
