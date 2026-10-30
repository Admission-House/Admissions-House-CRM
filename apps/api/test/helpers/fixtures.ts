import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PasswordService } from '../../src/auth/password.service.js';

export const OFFICE = { lat: 28.6021, lng: 77.4309 };
export const OFFICE_IP = '10.20.0.5';
export const OUTSIDE_IP = '203.0.113.50';
export const PASSWORD = 'Correct-horse-2026';

export interface TestUser {
  id: string;
  email: string;
}

export type RoleKey = 'super_admin' | 'admin' | 'counsellor';

export interface UserSpec {
  name: string;
  role: RoleKey;
  status?: 'active' | 'inactive';
  mustChange?: boolean;
  /** Name of another user in the same fixture. */
  manager?: string;
}

export interface Fixture {
  tenantId: string;
  slug: string;
  branchId: string;
  owner: pg.Client;
  roleId(key: RoleKey): string;
  user(name: string): TestUser;
  /** Adds a user straight into the database, for tests that need a special role. */
  addUser(spec: { name: string; roleId: string; managerName?: string; branch?: boolean }): Promise<TestUser>;
  /** Plain API keys for the two lead sources. */
  keys: { website: string; ads: string };
  sourceId(name: 'Website' | 'Meta Ads'): string;
  cleanup(): Promise<void>;
}

// Super Admins can sign in from anywhere, so each test that changes an account's state gets its
// own. Admin and counsellor must sign in from the office.
export const DEFAULT_USERS: UserSpec[] = [
  { name: 'super', role: 'super_admin' },
  { name: 'admin', role: 'admin' },
  { name: 'admin2', role: 'admin' },
  { name: 'counsellor', role: 'counsellor', manager: 'admin' },
  { name: 'counsellor2', role: 'counsellor', manager: 'admin2' },
  { name: 'mobile', role: 'counsellor', manager: 'admin' },
  { name: 'lockme', role: 'super_admin' },
  { name: 'inactive', role: 'super_admin', status: 'inactive' },
  { name: 'mustchange', role: 'super_admin', mustChange: true },
  { name: 'logout', role: 'super_admin' },
  { name: 'idle', role: 'super_admin' },
  { name: 'expired', role: 'super_admin' },
  { name: 'perms', role: 'counsellor', manager: 'admin' },
  { name: 'deactivate', role: 'super_admin' },
  { name: 'refresh', role: 'super_admin' },
  { name: 'reuse', role: 'super_admin' },
  { name: 'race', role: 'super_admin' },
  { name: 'pwchange', role: 'super_admin' },
  { name: 'sessions', role: 'super_admin' },
  { name: 'throttle', role: 'super_admin' },
  { name: 'victim', role: 'counsellor', manager: 'admin' },
  { name: 'resetme', role: 'counsellor', manager: 'admin' },
  { name: 'adminmobile', role: 'admin' },
  { name: 'att1', role: 'counsellor', manager: 'admin' },
  { name: 'att2', role: 'counsellor', manager: 'admin' },
  { name: 'att3', role: 'counsellor', manager: 'admin' },
  { name: 'att4', role: 'counsellor', manager: 'admin' },
  { name: 'att5', role: 'counsellor', manager: 'admin' },
  { name: 'att6', role: 'counsellor', manager: 'admin' },
  { name: 'att7', role: 'counsellor', manager: 'admin' },
  { name: 'att8', role: 'counsellor', manager: 'admin' },
  { name: 'att9', role: 'counsellor', manager: 'admin' },
  { name: 'att10', role: 'counsellor', manager: 'admin' },
  { name: 'att11', role: 'counsellor', manager: 'admin' },
  { name: 'att12', role: 'counsellor', manager: 'admin' },
  { name: 'lc1', role: 'counsellor', manager: 'admin' },
  { name: 'lc2', role: 'counsellor', manager: 'admin' },
  { name: 'lc3', role: 'counsellor', manager: 'admin' },
  { name: 'in1', role: 'counsellor', manager: 'admin' },
  { name: 'in2', role: 'counsellor', manager: 'admin' },
  { name: 'in3', role: 'counsellor', manager: 'admin' },
  { name: 'in4', role: 'counsellor', manager: 'admin' },
  { name: 'inleave', role: 'counsellor', manager: 'admin' },
  { name: 'lv1', role: 'counsellor', manager: 'admin' },
  { name: 'lv2', role: 'counsellor', manager: 'admin' },
  { name: 'lv3', role: 'counsellor', manager: 'admin' },
  { name: 'lv4', role: 'counsellor', manager: 'admin' },
  { name: 'lv5', role: 'counsellor', manager: 'admin' },
  { name: 'lv6', role: 'counsellor', manager: 'admin' },
  { name: 'lv7', role: 'counsellor', manager: 'admin' },
  { name: 'lv8', role: 'counsellor', manager: 'admin' },
  { name: 'lv9', role: 'counsellor', manager: 'admin' },
  { name: 'lv10', role: 'counsellor', manager: 'admin' },
];

const STANDARD_PERMISSIONS: Record<Exclude<RoleKey, 'super_admin'>, string[]> = {
  admin: ['lead.read', 'lead.create', 'lead.update', 'lead.assign', 'lead.import', 'lead.export', 'call.place', 'dashboard.read', 'report.read', 'report.export', 'salary.write', 'salary.read', 'salary.import', 'salary.read_own', 'call.read', 'call.listen', 'dialer.use', 'followup.manage', 'user.read', 'device.approve', 'branch.read', 'attendance.self', 'attendance.read', 'attendance.exception', 'leave.request', 'leave.read', 'leave.approve', 'master.read', 'master.create', 'master.review', 'shortlist.manage', 'document.manage'],
  counsellor: ['lead.read', 'dashboard.read', 'report.read', 'salary.read_own', 'call.place', 'dialer.use', 'call.read', 'lead.create', 'lead.update', 'followup.manage', 'attendance.self', 'leave.request', 'master.read', 'master.create', 'shortlist.manage', 'document.manage'],
};

/** A company with the three standard roles, an office, and users, in the real database. */
export async function createFixture(owner: pg.Client, specs: UserSpec[] = DEFAULT_USERS): Promise<Fixture> {
  const run = randomUUID().slice(0, 8);
  const slug = `t-${run}`;
  const hash = await new PasswordService().hash(PASSWORD);

  const q = (text: string, params?: unknown[]) => owner.query(text, params);
  const tenantId = (
    await q(`INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`, [`Test ${run}`, slug])
  ).rows[0].id as string;

  const roleIds = {} as Record<RoleKey, string>;
  for (const [key, scope, office] of [
    ['super_admin', 'all', false],
    ['admin', 'team', true],
    ['counsellor', 'own', true],
  ] as const) {
    roleIds[key] = (
      await q(
        `INSERT INTO roles (tenant_id, name, system_key, data_scope, requires_office, is_system)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [tenantId, key, key, scope, office],
      )
    ).rows[0].id;
  }
  await q(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions`,
    [tenantId, roleIds.super_admin],
  );
  for (const key of ['admin', 'counsellor'] as const) {
    await q(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       SELECT $1, $2, id FROM permissions WHERE code = ANY($3::text[])`,
      [tenantId, roleIds[key], STANDARD_PERMISSIONS[key]],
    );
  }

  const branchId = (
    await q(
      `INSERT INTO branches (tenant_id, name, latitude, longitude, radius_m)
       VALUES ($1, 'Office', $2, $3, 200) RETURNING id`,
      [tenantId, OFFICE.lat, OFFICE.lng],
    )
  ).rows[0].id as string;
  await q(
    `INSERT INTO branch_networks (tenant_id, branch_id, kind, ip_range) VALUES ($1, $2, 'ip_range', '10.20.0.0/16')`,
    [tenantId, branchId],
  );
  await q(
    `INSERT INTO attendance_settings (tenant_id, effective_from, shift_start, shift_end, idle_timeout_min)
     VALUES ($1, CURRENT_DATE - 30, '10:00', '19:00', 30)`,
    [tenantId],
  );

  // Lead configuration: statuses, two sources with a key each, and a stream.
  await q(
    `INSERT INTO lead_statuses (tenant_id, name, queue, is_open, requires_followup, sort_order) VALUES
       ($1, 'New', 'fresh', true, false, 0), ($1, 'Contacted', 'followup', true, false, 1),
       ($1, 'Follow-up', 'followup', true, true, 2), ($1, 'Counselled', 'counselled', true, true, 3),
       ($1, 'Fee Paid', 'fee_paid', true, false, 4), ($1, 'Not Interested', 'closed', false, false, 5)`,
    [tenantId],
  );
  const sourceIds = {} as Record<string, string>;
  const keys = { website: `ahk_${randomBytes(32).toString('base64url')}`, ads: `ahk_${randomBytes(32).toString('base64url')}` };
  for (const [name, channel, key] of [['Website', 'website', keys.website], ['Meta Ads', 'ads', keys.ads]] as const) {
    sourceIds[name] = (await q(`INSERT INTO lead_sources (tenant_id, name, channel_type) VALUES ($1, $2, $3) RETURNING id`, [tenantId, name, channel])).rows[0].id;
    await q(`INSERT INTO api_keys (tenant_id, source_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4, $5)`, [tenantId, sourceIds[name], `${name} key`, key.slice(0, 8), createHash('sha256').update(key).digest('hex')]);
  }
  await q(`INSERT INTO streams (tenant_id, name) VALUES ($1, 'Engineering')`, [tenantId]);

  for (const [name, paid, quota] of [['Casual Leave', true, 12], ['Sick Leave', true, 6], ['Unpaid Leave', false, 0]] as const) {
    await q(`INSERT INTO leave_types (tenant_id, name, is_paid, yearly_quota) VALUES ($1, $2, $3, $4)`, [tenantId, name, paid, quota]);
  }
  for (const [name, minutes] of [['Lunch', 45], ['Tea', 15]] as const) {
    await q(`INSERT INTO break_types (tenant_id, name, allowed_minutes) VALUES ($1, $2, $3)`, [tenantId, name, minutes]);
  }

  const users = new Map<string, TestUser>();
  const insert = async (name: string, roleId: string, opts: { role?: RoleKey; manager?: string; status?: string; mustChange?: boolean; branch: boolean }) => {
    const email = `${name}-${run}@test.example`;
    const id = (
      await q(
        `INSERT INTO users (tenant_id, role_id, branch_id, manager_id, name, email, password_hash, status, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          tenantId,
          roleId,
          opts.branch ? branchId : null,
          opts.manager ? users.get(opts.manager)!.id : null,
          name,
          email,
          hash,
          opts.status ?? 'active',
          opts.mustChange ?? false,
        ],
      )
    ).rows[0].id as string;
    users.set(name, { id, email });
    return users.get(name)!;
  };

  for (const spec of specs) {
    await insert(spec.name, roleIds[spec.role], {
      manager: spec.manager,
      status: spec.status,
      mustChange: spec.mustChange,
      branch: spec.role !== 'super_admin',
    });
  }

  return {
    tenantId,
    slug,
    branchId,
    owner,
    roleId: (key) => roleIds[key],
    keys,
    sourceId: (name) => sourceIds[name]!,
    user(name) {
      const found = users.get(name);
      if (!found) throw new Error(`no test user "${name}"`);
      return found;
    },
    addUser: (spec) => insert(spec.name, spec.roleId, { manager: spec.managerName, branch: spec.branch ?? false }),
    async cleanup() {
      const tables = [
        'audit_logs', 'login_attempts', 'notifications', 'lead_enquiries', 'lead_activities', 'lead_profiles', 'lead_phones',
        'password_reset_tokens', 'custom_field_values', 'custom_field_options', 'custom_field_defs', 'salary_records', 'salary_import_batches', 'call_recordings', 'calls', 'dialer_session_leads', 'dialer_sessions', 'telephony_connections', 'lead_import_batches', 'lead_documents', 'lead_shortlist_courses', 'lead_shortlists', 'lead_recommendations', 'followups', 'leads', 'inbound_events', 'api_keys', 'assignment_rule_users', 'assignment_rules', 'lead_policies', 'lead_statuses',
        'lead_sources', 'college_courses', 'colleges', 'courses', 'streams', 'tenant_counters',
        'break_logs', 'attendance_exceptions', 'attendance_records',
        'leave_requests', 'holidays', 'leave_balances', 'leave_types',
        'user_sessions', 'user_devices', 'leave_balances', 'user_profiles', 'role_permissions', 'users',
        'branch_networks', 'branches', 'attendance_settings', 'break_types', 'roles',
      ];
      for (const table of tables) await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      await q(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    },
  };
}
