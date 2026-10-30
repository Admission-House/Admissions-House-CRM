// Removes companies left behind by an interrupted test run.
//
//   node --env-file=.env test/purge-test-tenants.mjs
//
// Only a company whose slug looks like t-xxxxxxxx / iso-xxxxxxxx AND whose name starts with
// "Test " is touched. A real company can never match both.

import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
await client.connect();

// Children before parents.
const TABLES = [
  'audit_logs', 'login_attempts', 'notifications', 'lead_enquiries', 'lead_activities', 'lead_profiles', 'lead_phones',
  'password_reset_tokens', 'custom_field_values', 'custom_field_options', 'custom_field_defs', 'salary_records', 'salary_import_batches', 'call_recordings', 'calls', 'dialer_session_leads', 'dialer_sessions', 'telephony_connections', 'lead_import_batches', 'lead_documents', 'lead_shortlist_courses', 'lead_shortlists', 'lead_recommendations', 'followups', 'leads', 'inbound_events', 'api_keys', 'assignment_rule_users', 'assignment_rules', 'lead_policies', 'lead_statuses',
  'lead_sources', 'college_courses', 'colleges', 'courses', 'streams', 'tenant_counters', 'break_logs', 'attendance_exceptions', 'attendance_records',
  'leave_requests', 'holidays', 'leave_balances', 'leave_types', 'user_sessions', 'user_devices', 'user_profiles',
  'role_permissions', 'users', 'branch_networks', 'branches', 'attendance_settings', 'break_types', 'roles',
];

try {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT id, slug FROM tenants WHERE slug ~ '^(t|iso)-[0-9a-f]{8}$' AND name ~ '^Test '`,
  );
  const ids = rows.map((r) => r.id);
  for (const table of TABLES) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [ids]);
  }
  await client.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [ids]);
  // Shared places that tests add (cities first, then their states).
  await client.query("DELETE FROM locations WHERE type = 'city' AND name ~ '^Testville-'");
  await client.query("DELETE FROM locations WHERE type = 'state' AND name ~ '^TestState-'");
  await client.query('COMMIT');
  console.log(rows.length ? `removed ${rows.length} test companies: ${rows.map((r) => r.slug).join(', ')}` : 'nothing to remove');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('failed, nothing removed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
