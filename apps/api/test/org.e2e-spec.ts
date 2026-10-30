import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { PasswordService } from '../src/auth/password.service.js';
import { Client, inOffice, makeClient } from './helpers/client.js';
import { startApp } from './helpers/app.js';
import { createFixture, Fixture, OFFICE, OFFICE_IP, PASSWORD } from './helpers/fixtures.js';

let app: NestFastifyApplication;
let owner: pg.Client;
let fx: Fixture;
let api: Client;
let sa: string; // Super Admin
let admin: string; // Admin of "counsellor", "mobile", "victim"...
let admin2: string; // Admin of "counsellor2"

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  fx = await createFixture(owner);
  app = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '300' });
  api = makeClient(app, fx);
  sa = await api.signIn('super');
  admin = await api.signIn('admin', { office: true });
  admin2 = await api.signIn('admin2', { office: true });
});

afterAll(async () => {
  await app?.close();
  await fx?.cleanup();
  await owner?.end();
});

const errorCode = (res: { json: () => { error?: { code?: string } } }) => res.json().error?.code;
const auditCount = async (action: string) =>
  Number((await owner.query(`SELECT count(*) FROM audit_logs WHERE tenant_id = $1 AND action = $2`, [fx.tenantId, action])).rows[0].count);

/** A person with a hand-made role, to test what someone short of Super Admin can and cannot do. */
async function personWithRole(name: string, permissions: string[], dataScope = 'all') {
  const roleId = (
    await owner.query(
      `INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, $2, $3, false) RETURNING id`,
      [fx.tenantId, `role-${name}`, dataScope],
    )
  ).rows[0].id as string;
  await owner.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = ANY($3::text[])`,
    [fx.tenantId, roleId, permissions],
  );
  await fx.addUser({ name, roleId });
  return { roleId, token: await api.signIn(name) };
}

// =========================================================================== roles

describe('roles and permissions', () => {
  it('lists every permission, grouped, for those who manage roles only', async () => {
    const res = await api.call('GET', '/permissions', sa);
    expect(res.statusCode).toBe(200);
    const total = res.json().reduce((n: number, g: { permissions: unknown[] }) => n + g.permissions.length, 0);
    expect(total).toBe(43);
    expect((await api.call('GET', '/permissions', admin, undefined, OFFICE_IP)).statusCode).toBe(403);
  });

  it('lists role names for anyone who can read users, with counts', async () => {
    const res = await api.call('GET', '/roles', admin, undefined, OFFICE_IP);
    expect(res.statusCode).toBe(200);
    const byKey = Object.fromEntries(res.json().map((r: { key: string }) => [r.key, r]));
    expect(byKey.super_admin).toMatchObject({ dataScope: 'all', isSystem: true });
    expect(byKey.counsellor.userCount).toBeGreaterThan(3);
  });

  it('creates, edits and deletes a custom role', async () => {
    const created = await api.call('POST', '/roles', sa, {
      name: 'Team Lead', dataScope: 'team', requiresOffice: true, permissions: ['lead.read', 'lead.update', 'lead.read'],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Team Lead', isSystem: false, permissions: ['lead.read', 'lead.update'] });
    const id = created.json().id;

    const duplicate = await api.call('POST', '/roles', sa, { name: 'team lead', dataScope: 'own', requiresOffice: true, permissions: [] });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate)).toBe('ROLE_NAME_TAKEN');

    const edited = await api.call('PATCH', `/roles/${id}`, sa, { permissions: ['lead.read', 'followup.manage'], requiresOffice: false });
    expect(edited.json()).toMatchObject({ requiresOffice: false, permissions: ['followup.manage', 'lead.read'] });

    expect((await api.call('DELETE', `/roles/${id}`, sa)).statusCode).toBe(204);
    expect((await api.call('GET', `/roles/${id}`, sa)).statusCode).toBe(404);
    expect(await auditCount('role.create')).toBeGreaterThanOrEqual(1);
    expect(await auditCount('role.delete')).toBeGreaterThanOrEqual(1);
  });

  it('changes only the permissions of a role', async () => {
    const created = await api.call('POST', '/roles', sa, { name: 'Perms Only', dataScope: 'own', requiresOffice: false, permissions: ['lead.read'] });
    const edited = await api.call('PATCH', `/roles/${created.json().id}`, sa, { permissions: ['lead.read', 'lead.update'] });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().permissions).toEqual(['lead.read', 'lead.update']);
    // The standard Admin role's permissions can be edited on their own too.
    const adminRole = await api.call('GET', `/roles/${fx.roleId('admin')}`, sa);
    const same = await api.call('PATCH', `/roles/${fx.roleId('admin')}`, sa, { permissions: adminRole.json().permissions });
    expect(same.statusCode, same.body).toBe(200);
  });

  it('rejects unknown permissions and malformed requests', async () => {
    const unknown = await api.call('POST', '/roles', sa, { name: 'Odd', dataScope: 'own', requiresOffice: true, permissions: ['lead.fly'] });
    expect(errorCode(unknown)).toBe('UNKNOWN_PERMISSION');
    const malformed = await api.call('POST', '/roles', sa, { name: 'X', dataScope: 'galaxy', requiresOffice: 'yes', permissions: ['NOT A CODE'] });
    expect(errorCode(malformed)).toBe('VALIDATION_FAILED');
    const empty = await api.call('PATCH', `/roles/${fx.roleId('admin')}`, sa, {});
    expect(errorCode(empty)).toBe('VALIDATION_FAILED');
  });

  it('protects the standard roles', async () => {
    const superRole = await api.call('PATCH', `/roles/${fx.roleId('super_admin')}`, sa, { permissions: ['lead.read'] });
    expect(superRole.statusCode).toBe(409);
    expect(errorCode(superRole)).toBe('ROLE_LOCKED');

    const rename = await api.call('PATCH', `/roles/${fx.roleId('admin')}`, sa, { name: 'Boss' });
    expect(errorCode(rename)).toBe('ROLE_LOCKED');

    expect(errorCode(await api.call('DELETE', `/roles/${fx.roleId('counsellor')}`, sa))).toBe('ROLE_LOCKED');
  });

  it('will not delete a role that people still have', async () => {
    const { roleId } = await personWithRole('holder', ['lead.read']);
    const res = await api.call('DELETE', `/roles/${roleId}`, sa);
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('ROLE_IN_USE');
  });

  it('does not let anyone hand out more than they hold', async () => {
    const lite = await personWithRole('rolelite', ['role.manage', 'user.read', 'user.manage', 'lead.read']);

    const grantMore = await api.call('POST', '/roles', lite.token, { name: 'Payroll', dataScope: 'all', requiresOffice: false, permissions: ['salary.write'] });
    expect(grantMore.statusCode).toBe(403);
    expect(errorCode(grantMore)).toBe('PERMISSION_ESCALATION');
    expect(grantMore.json().error.message).toContain('salary.write');

    const ok = await api.call('POST', '/roles', lite.token, { name: 'Reader', dataScope: 'all', requiresOffice: false, permissions: ['lead.read'] });
    expect(ok.statusCode).toBe(201);

    // Editing a role to add something they do not hold is refused as well.
    const grabAdmin = await api.call('PATCH', `/roles/${fx.roleId('counsellor')}`, lite.token, { permissions: ['lead.read', 'salary.write'] });
    expect(errorCode(grabAdmin)).toBe('PERMISSION_ESCALATION');
  });

  it('does not let a team-level person create a role that sees more than they do', async () => {
    const lead = await personWithRole('teamrole', ['role.manage', 'lead.read'], 'team');
    const wider = await api.call('POST', '/roles', lead.token, { name: 'Wide', dataScope: 'all', requiresOffice: false, permissions: [] });
    expect(errorCode(wider)).toBe('SCOPE_ESCALATION');
    const same = await api.call('POST', '/roles', lead.token, { name: 'Narrow', dataScope: 'own', requiresOffice: false, permissions: ['lead.read'] });
    expect(same.statusCode).toBe(201);
  });
});

// =========================================================================== users

describe('users', () => {
  const newCounsellor = (over: Record<string, unknown> = {}) => ({
    name: 'Asha Verma',
    email: `asha-${Math.random().toString(36).slice(2, 8)}@test.example`,
    phone: '98765 43210',
    roleId: fx.roleId('counsellor'),
    branchId: fx.branchId,
    managerId: fx.user('admin').id,
    designation: 'Counsellor',
    ...over,
  });

  it('creates a person with a one-time password that must be changed at first sign-in', async () => {
    const body = newCounsellor();
    const res = await api.call('POST', '/users', sa, body);
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    const { user, temporaryPassword } = res.json();
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
    expect(user).toMatchObject({
      name: 'Asha Verma', phone: '919876543210', status: 'active', mustChangePassword: true, designation: 'Counsellor',
      role: { key: 'counsellor' }, branch: { name: 'Office' }, manager: { name: 'admin' },
    });
    expect(JSON.stringify(res.json())).not.toMatch(/argon2|password_hash/);

    const signedIn = await api.login({ tenant: fx.slug, email: body.email, password: temporaryPassword, location: inOffice }, OFFICE_IP);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().mustChangePassword).toBe(true);
    expect(await auditCount('user.create')).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['a counsellor without a manager', { managerId: null }, 'MANAGER_REQUIRED'],
    ['a counsellor reporting to another counsellor', { managerId: 'counsellor' }, 'MANAGER_INVALID'],
    ['an Admin without an office', { roleId: 'admin', branchId: null, managerId: null }, 'BRANCH_REQUIRED'],
    ['a Super Admin with a manager', { roleId: 'super_admin', branchId: null }, 'MANAGER_INVALID'],
    ['an email that is already used', { email: 'EMAIL_OF_ADMIN' }, 'EMAIL_TAKEN'],
    ['a role that does not exist', { roleId: '00000000-0000-4000-8000-000000000000' }, 'ROLE_NOT_FOUND'],
    ['an office that does not exist', { branchId: '00000000-0000-4000-8000-000000000000' }, 'BRANCH_NOT_FOUND'],
  ])('refuses %s', async (_name, change, code) => {
    const resolved = Object.fromEntries(
      Object.entries(change).map(([k, v]) => {
        if (k === 'roleId' && (v === 'admin' || v === 'super_admin')) return [k, fx.roleId(v)];
        if (k === 'managerId' && v === 'counsellor') return [k, fx.user('counsellor').id];
        if (k === 'email' && v === 'EMAIL_OF_ADMIN') return [k, fx.user('admin').email.toUpperCase()];
        return [k, v];
      }),
    );
    const res = await api.call('POST', '/users', sa, newCounsellor(resolved));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(errorCode(res)).toBe(code);
  });

  it('checks the details with field errors', async () => {
    const res = await api.call('POST', '/users', sa, newCounsellor({ phone: '12345', email: 'nope', name: 'A' }));
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(res.json().error.fieldErrors.map((f: { field: string }) => f.field).sort()).toEqual(['email', 'name', 'phone']);
  });

  it('shows an Admin only their own team and hides everyone else as if they did not exist', async () => {
    const mine = await api.call('GET', '/users?limit=100', admin, undefined, OFFICE_IP);
    const names = mine.json().items.map((u: { name: string }) => u.name);
    expect(names).toEqual(expect.arrayContaining(['admin', 'counsellor', 'mobile', 'victim']));
    expect(names).not.toContain('admin2');
    expect(names).not.toContain('counsellor2');
    expect(names).not.toContain('super');

    expect((await api.call('GET', `/users/${fx.user('counsellor2').id}`, admin, undefined, OFFICE_IP)).statusCode).toBe(404);
    expect((await api.call('GET', `/users/${fx.user('super').id}`, admin, undefined, OFFICE_IP)).statusCode).toBe(404);
    expect((await api.call('GET', `/users/${fx.user('counsellor').id}`, admin, undefined, OFFICE_IP)).statusCode).toBe(200);
  });

  it('keeps a counsellor out of the user list altogether', async () => {
    const token = await api.signIn('counsellor', { office: true });
    expect((await api.call('GET', '/users', token, undefined, OFFICE_IP)).statusCode).toBe(403);
  });

  it('pages through everyone exactly once, in name order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/users?limit=7${cursor ? `&cursor=${cursor}` : ''}`, sa);
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((u: { id: string }) => u.id));
      cursor = res.json().nextCursor;
      pages++;
    } while (cursor && pages < 50);

    const expected = (
      await owner.query(`SELECT id FROM users WHERE tenant_id = $1 ORDER BY lower(name), id`, [fx.tenantId])
    ).rows.map((r) => r.id);
    expect(seen).toEqual(expected);
    expect(pages).toBeGreaterThan(2);
  });

  it('searches and filters', async () => {
    const found = await api.call('GET', '/users?q=counsellor2', sa);
    expect(found.json().items.map((u: { name: string }) => u.name)).toEqual(['counsellor2']);

    const inactive = await api.call('GET', '/users?status=inactive', sa);
    expect(inactive.json().items.map((u: { name: string }) => u.name)).toContain('inactive');
    expect(inactive.json().items.every((u: { status: string }) => u.status === 'inactive')).toBe(true);

    const team = await api.call('GET', `/users?managerId=${fx.user('admin2').id}`, sa);
    expect(team.json().items.map((u: { name: string }) => u.name)).toEqual(['counsellor2']);

    const wildcard = await api.call('GET', '/users?q=%25', sa);
    expect(wildcard.json().items).toHaveLength(0);
    expect(errorCode(await api.call('GET', '/users?cursor=forged', sa))).toBe('INVALID_CURSOR');
    expect(errorCode(await api.call('GET', '/users?limit=500', sa))).toBe('VALIDATION_FAILED');
  });

  it('edits a person and records what changed', async () => {
    const id = fx.user('counsellor2').id;
    const res = await api.call('PATCH', `/users/${id}`, sa, { name: 'Counsellor Two', phone: '9123456780', designation: 'Senior', managerId: fx.user('admin').id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Counsellor Two', phone: '919123456780', designation: 'Senior', manager: { name: 'admin' } });

    const log = await owner.query(`SELECT before, after FROM audit_logs WHERE tenant_id = $1 AND action = 'user.update' AND entity_id = $2`, [fx.tenantId, id]);
    expect(log.rows[0].before.name).toBe('counsellor2');
    expect(log.rows[0].after.name).toBe('Counsellor Two');
    expect(JSON.stringify(log.rows)).not.toMatch(/password/);
  });

  it('keeps the shape of the organisation when editing', async () => {
    const id = fx.user('resetme').id;
    expect(errorCode(await api.call('PATCH', `/users/${id}`, sa, { managerId: fx.user('counsellor').id }))).toBe('MANAGER_INVALID');
    expect(errorCode(await api.call('PATCH', `/users/${id}`, sa, { managerId: null }))).toBe('MANAGER_REQUIRED');
    expect(errorCode(await api.call('PATCH', `/users/${id}`, sa, { branchId: null }))).toBe('BRANCH_REQUIRED');
    expect(errorCode(await api.call('PATCH', `/users/${id}`, sa, { managerId: id }))).toBe('MANAGER_INVALID');
  });

  it('signs a person out everywhere when they are deactivated, and lets them back in when reactivated', async () => {
    const token = await api.signIn('victim', { office: true });
    expect((await api.call('GET', '/auth/me', token, undefined, OFFICE_IP)).statusCode).toBe(200);

    const off = await api.call('PATCH', `/users/${fx.user('victim').id}`, sa, { status: 'inactive' });
    expect(off.json().status).toBe('inactive');
    expect(errorCode(await api.call('GET', '/auth/me', token, undefined, OFFICE_IP))).toBe('SESSION_ENDED');
    expect(errorCode(await api.login({ ...api.credentials('victim'), location: inOffice }, OFFICE_IP))).toBe('ACCOUNT_INACTIVE');

    await api.call('PATCH', `/users/${fx.user('victim').id}`, sa, { status: 'active' });
    expect((await api.login({ ...api.credentials('victim'), location: inOffice }, OFFICE_IP)).statusCode).toBe(200);
  });

  it('will not deactivate an Admin who still has a team', async () => {
    const res = await api.call('PATCH', `/users/${fx.user('admin')['id']}`, sa, { status: 'inactive' });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('HAS_ACTIVE_TEAM');
  });

  it('will not let anyone change their own role, office, manager or status', async () => {
    const res = await api.call('PATCH', `/users/${fx.user('super').id}`, sa, { status: 'inactive' });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('SELF_CHANGE_NOT_ALLOWED');
    const ok = await api.call('PATCH', `/users/${fx.user('super').id}`, sa, { designation: 'Owner' });
    expect(ok.statusCode).toBe(200);
  });

  describe('resetting a password', () => {
    it('signs the person out, sets a one-time password and clears a lock', async () => {
      const id = fx.user('resetme').id;
      const old = await api.signIn('resetme', { office: true });
      await owner.query(`UPDATE users SET failed_logins = 5, locked_until = now() + interval '10 minutes' WHERE id = $1`, [id]);

      const res = await api.call('POST', `/users/${id}/reset-password`, sa);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { temporaryPassword } = res.json();

      expect(errorCode(await api.call('GET', '/auth/me', old, undefined, OFFICE_IP))).toBe('SESSION_ENDED');
      expect(errorCode(await api.login({ ...api.credentials('resetme'), location: inOffice }, OFFICE_IP))).toBe('INVALID_CREDENTIALS');
      const fresh = await api.login({ ...api.credentials('resetme', temporaryPassword), location: inOffice }, OFFICE_IP);
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().mustChangePassword).toBe(true);
      expect(await auditCount('user.password_reset')).toBeGreaterThanOrEqual(1);
    });

    it('is not available for your own account, and not to someone without the permission', async () => {
      expect(errorCode(await api.call('POST', `/users/${fx.user('super').id}/reset-password`, sa))).toBe('USE_CHANGE_PASSWORD');
      expect((await api.call('POST', `/users/${fx.user('counsellor').id}/reset-password`, admin, undefined, OFFICE_IP)).statusCode).toBe(403);
    });
  });

  describe('someone who manages users but has less access than Super Admin', () => {
    it('cannot create, change or reset anyone more powerful than themselves', async () => {
      // Holds everything a counsellor holds (so it may manage counsellors) plus user management, but
      // nothing more, however the standard roles are set up.
      const counsellorPermissions = (
        await owner.query(
          `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
          [fx.roleId('counsellor')],
        )
      ).rows.map((r) => r.code as string);
      const hr = await personWithRole('hrlite', ['user.read', 'user.manage', ...counsellorPermissions]);

      const makeSuper = await api.call('POST', '/users', hr.token, {
        name: 'Sneaky', email: 'sneaky@test.example', roleId: fx.roleId('super_admin'),
      });
      expect(errorCode(makeSuper)).toBe('PERMISSION_ESCALATION');

      const resetSuper = await api.call('POST', `/users/${fx.user('super').id}/reset-password`, hr.token);
      expect(resetSuper.statusCode).toBe(403);
      expect(errorCode(resetSuper)).toBe('TARGET_MORE_POWERFUL');

      const editSuper = await api.call('PATCH', `/users/${fx.user('super').id}`, hr.token, { name: 'Hacked' });
      expect(errorCode(editSuper)).toBe('TARGET_MORE_POWERFUL');

      const promoteSelfFriend = await api.call('PATCH', `/users/${fx.user('counsellor').id}`, hr.token, { roleId: fx.roleId('super_admin'), managerId: null, branchId: null });
      expect(errorCode(promoteSelfFriend)).toBe('PERMISSION_ESCALATION');
    });
  });
});

describe('the last Super Admin', () => {
  it('cannot be deactivated or demoted by someone else who holds every permission', async () => {
    // A company with exactly one Super Admin, and a "co-owner" role that holds all permissions
    // but is not the Super Admin role.
    const solo = await createFixture(owner, [{ name: 'only', role: 'super_admin' }]);
    const soloApp = await startApp({ LOGIN_IP_MAX_ATTEMPTS: '300' });
    try {
      const client = makeClient(soloApp, solo);
      const coRole = (await owner.query(`INSERT INTO roles (tenant_id, name, data_scope, requires_office) VALUES ($1, 'Co-owner', 'all', false) RETURNING id`, [solo.tenantId])).rows[0].id;
      await owner.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions`, [solo.tenantId, coRole]);
      await solo.addUser({ name: 'coowner', roleId: coRole });
      const token = await client.signIn('coowner');

      const off = await client.call('PATCH', `/users/${solo.user('only').id}`, token, { status: 'inactive' });
      expect(off.statusCode).toBe(409);
      expect(errorCode(off)).toBe('LAST_SUPER_ADMIN');

      const demote = await client.call('PATCH', `/users/${solo.user('only').id}`, token, { roleId: coRole });
      expect(errorCode(demote)).toBe('LAST_SUPER_ADMIN');
    } finally {
      await soloApp.close();
      await solo.cleanup();
    }
  });
});

// =========================================================================== branches

describe('branches and networks', () => {
  const createBranch = (name: string) => api.call('POST', '/branches', sa, { name, address: 'Test road' });

  it('lets an Admin read offices but not change them', async () => {
    const list = await api.call('GET', '/branches', admin, undefined, OFFICE_IP);
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toMatchObject({ name: 'Office', latitude: OFFICE.lat, longitude: OFFICE.lng, radiusM: 200 });
    expect(list.json()[0].networks[0]).toMatchObject({ kind: 'ip_range', ipRange: '10.20.0.0/16' });
    expect((await api.call('POST', '/branches', admin, { name: 'X Office' }, OFFICE_IP)).statusCode).toBe(403);
  });

  it('creates, renames and closes an office', async () => {
    const created = await createBranch('Second Office');
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ latitude: null, longitude: null, radiusM: 200, userCount: 0, networks: [] });
    const id = created.json().id;

    expect(errorCode(await createBranch('second office'))).toBe('BRANCH_NAME_TAKEN');
    const edited = await api.call('PATCH', `/branches/${id}`, sa, { radiusM: 300, address: null });
    expect(edited.json()).toMatchObject({ radiusM: 300, address: null });
    expect(errorCode(await api.call('PATCH', `/branches/${id}`, sa, { radiusM: 5 }))).toBe('VALIDATION_FAILED');
    expect((await api.call('PATCH', `/branches/${id}`, sa, { isActive: false })).json().isActive).toBe(false);
  });

  it('will not close an office that people are placed in', async () => {
    const res = await api.call('PATCH', `/branches/${fx.branchId}`, sa, { isActive: false });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('BRANCH_IN_USE');
  });

  it('manages allowed networks and refuses ranges that would switch the check off', async () => {
    const id = (await createBranch('Network Office')).json().id;

    const added = await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'ip_range', ipRange: '203.0.113.0/28' });
    expect(added.statusCode).toBe(201);
    expect(added.json().networks[0]).toMatchObject({ kind: 'ip_range', ipRange: '203.0.113.0/28' });
    const single = await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'ip_range', ipRange: '198.51.100.7' });
    expect(single.json().networks.map((n: { ipRange: string }) => n.ipRange)).toContain('198.51.100.7/32');

    expect(errorCode(await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'ip_range', ipRange: '203.0.113.0/28' }))).toBe('NETWORK_EXISTS');
    expect(errorCode(await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'ip_range', ipRange: '0.0.0.0/0' }))).toBe('NETWORK_INVALID');
    expect(errorCode(await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'ip_range', ipRange: 'my office' }))).toBe('NETWORK_INVALID');
    expect(errorCode(await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'wifi', ipRange: '1.2.3.4' }))).toBe('VALIDATION_FAILED');

    const wifi = await api.call('POST', `/branches/${id}/networks`, sa, { kind: 'wifi', wifiId: 'AH-Office-5G' });
    expect(wifi.json().networks.map((n: { kind: string }) => n.kind)).toContain('wifi');

    const networkId = wifi.json().networks.find((n: { kind: string }) => n.kind === 'wifi').id;
    const removed = await api.call('DELETE', `/branches/${id}/networks/${networkId}`, sa);
    expect(removed.json().networks.map((n: { kind: string }) => n.kind)).not.toContain('wifi');
    expect((await api.call('DELETE', `/branches/${id}/networks/${networkId}`, sa)).statusCode).toBe(404);
  });

  describe('setting up an office with the Detect button', () => {
    const OFFICE_PUBLIC_IP = '203.0.113.77';
    const reading = { lat: 28.6101, lng: 77.4411, accuracy: 18 };

    it('shows what the server sees without saving anything, then saves on confirmation', async () => {
      const id = (await createBranch('Annex')).json().id;

      const detected = await api.call('POST', `/branches/${id}/detect`, sa, reading, OFFICE_PUBLIC_IP);
      expect(detected.statusCode).toBe(200);
      expect(detected.json()).toMatchObject({
        observedIp: OFFICE_PUBLIC_IP, suggestedRange: `${OFFICE_PUBLIC_IP}/32`, canSave: true, movedFromCurrentM: null, warnings: [],
      });
      const untouched = await api.call('GET', `/branches/${id}`, sa);
      expect(untouched.json()).toMatchObject({ latitude: null, networks: [] });

      const confirmed = await api.call('POST', `/branches/${id}/detect/confirm`, sa, reading, OFFICE_PUBLIC_IP);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toMatchObject({ latitude: reading.lat, longitude: reading.lng });
      expect(confirmed.json().detectedAt).not.toBeNull();
      expect(confirmed.json().networks.map((n: { ipRange: string }) => n.ipRange)).toEqual([`${OFFICE_PUBLIC_IP}/32`]);

      // Confirming again does not add the same network twice.
      const again = await api.call('POST', `/branches/${id}/detect/confirm`, sa, reading, OFFICE_PUBLIC_IP);
      expect(again.json().networks).toHaveLength(1);

      // The point of it all: a counsellor placed in this office can now sign in from there, and only there.
      const created = await api.call('POST', '/users', sa, {
        name: 'Annex Counsellor', email: 'annex@test.example', roleId: fx.roleId('counsellor'), branchId: id, managerId: fx.user('admin').id,
      });
      const creds = { tenant: fx.slug, email: 'annex@test.example', password: created.json().temporaryPassword };
      const at = { lat: reading.lat, lng: reading.lng, accuracy: 20 };
      expect((await api.login({ ...creds, location: at }, OFFICE_PUBLIC_IP)).statusCode).toBe(200);
      expect(errorCode(await api.login({ ...creds, location: at }, '203.0.113.200'))).toBe('OUTSIDE_OFFICE');
      expect(errorCode(await api.login({ ...creds, location: { ...at, lat: at.lat + 0.05 } }, OFFICE_PUBLIC_IP))).toBe('OUTSIDE_OFFICE');
      expect(await auditCount('branch.detect')).toBeGreaterThanOrEqual(1);
    });

    it('refuses a vague reading and warns about an imprecise one', async () => {
      const id = (await createBranch('Vague Office')).json().id;
      const mediocre = await api.call('POST', `/branches/${id}/detect`, sa, { ...reading, accuracy: 70 }, OFFICE_PUBLIC_IP);
      expect(mediocre.json()).toMatchObject({ canSave: true });
      expect(mediocre.json().warnings[0]).toMatch(/not very precise/);

      const vague = await api.call('POST', `/branches/${id}/detect`, sa, { ...reading, accuracy: 150 }, OFFICE_PUBLIC_IP);
      expect(vague.json().canSave).toBe(false);
      expect(errorCode(await api.call('POST', `/branches/${id}/detect/confirm`, sa, { ...reading, accuracy: 150 }, OFFICE_PUBLIC_IP))).toBe('GPS_TOO_VAGUE');
    });

    it('does not quietly save a private address that cannot identify the office', async () => {
      const id = (await createBranch('Proxy Office')).json().id;
      const detected = await api.call('POST', `/branches/${id}/detect`, sa, reading, '10.1.2.3');
      expect(detected.json().suggestedRange).toBeNull();
      expect(detected.json().warnings.join(' ')).toMatch(/private address/);

      expect(errorCode(await api.call('POST', `/branches/${id}/detect/confirm`, sa, reading, '10.1.2.3'))).toBe('ADDRESS_NOT_PUBLIC');
      const positionOnly = await api.call('POST', `/branches/${id}/detect/confirm`, sa, { ...reading, addCurrentIp: false }, '10.1.2.3');
      expect(positionOnly.json()).toMatchObject({ latitude: reading.lat, networks: [] });
      const accepted = await api.call('POST', `/branches/${id}/detect/confirm`, sa, { ...reading, allowInternalAddress: true }, '10.1.2.3');
      expect(accepted.json().networks.map((n: { ipRange: string }) => n.ipRange)).toEqual(['10.1.2.3/32']);
    });

    it('reports how far the office moved when it already had a position', async () => {
      const res = await api.call('POST', `/branches/${fx.branchId}/detect`, sa, { lat: OFFICE.lat + 0.001, lng: OFFICE.lng, accuracy: 10 }, OFFICE_PUBLIC_IP);
      expect(res.json().movedFromCurrentM).toBeGreaterThan(100);
      expect(res.json().movedFromCurrentM).toBeLessThan(120);
    });

    it('is for those who manage offices only', async () => {
      expect((await api.call('POST', `/branches/${fx.branchId}/detect`, admin, reading, OFFICE_IP)).statusCode).toBe(403);
    });
  });
});

// =========================================================================== devices

describe('mobile devices', () => {
  const phone = (tail: string) => ({ fingerprint: `phone-fingerprint-${tail}`, platform: 'android', label: `Phone ${tail}` });
  const mobileLogin = (name: string, tail: string) =>
    api.login({ ...api.credentials(name), clientType: 'mobile', location: inOffice, device: phone(tail) }, OFFICE_IP);

  it('shows an Admin only the phones of their own team, and lets them approve and withdraw approval', async () => {
    expect(errorCode(await mobileLogin('mobile', 'aaaaaa'))).toBe('DEVICE_NOT_APPROVED');

    const mine = await api.call('GET', '/devices', admin, undefined, OFFICE_IP);
    expect(mine.statusCode).toBe(200);
    const device = mine.json().items.find((d: { user: { name: string } }) => d.user.name === 'mobile');
    expect(device).toMatchObject({ status: 'pending', platform: 'android', fingerprintTail: 'aaaaaa' });
    expect(JSON.stringify(device)).not.toContain('phone-fingerprint-aaaaaa');

    const theirs = await api.call('GET', '/devices?status=all', admin2, undefined, OFFICE_IP);
    expect(theirs.json().items.map((d: { id: string }) => d.id)).not.toContain(device.id);
    expect((await api.call('POST', `/devices/${device.id}/approve`, admin2, undefined, OFFICE_IP)).statusCode).toBe(404);

    const approved = await api.call('POST', `/devices/${device.id}/approve`, admin, undefined, OFFICE_IP);
    expect(approved.json()).toMatchObject({ status: 'approved', approvedBy: 'admin' });
    const signedIn = await mobileLogin('mobile', 'aaaaaa');
    expect(signedIn.statusCode).toBe(200);

    const revoked = await api.call('POST', `/devices/${device.id}/revoke`, admin, undefined, OFFICE_IP);
    expect(revoked.json().status).toBe('pending');
    expect(errorCode(await api.call('GET', '/auth/me', signedIn.json().accessToken, undefined, OFFICE_IP))).toBe('SESSION_ENDED');
    expect(errorCode(await mobileLogin('mobile', 'aaaaaa'))).toBe('DEVICE_NOT_APPROVED');
    expect(await auditCount('device.approve')).toBeGreaterThanOrEqual(1);
    expect(await auditCount('device.revoke')).toBeGreaterThanOrEqual(1);
  });

  it('does not let a person approve their own phone', async () => {
    expect(errorCode(await mobileLogin('adminmobile', 'bbbbbb'))).toBe('DEVICE_NOT_APPROVED');
    const own = await api.call('GET', '/devices?status=all&limit=100', sa);
    const device = own.json().items.find((d: { user: { name: string } }) => d.user.name === 'adminmobile');

    const adminMobileToken = await api.signIn('adminmobile', { office: true });
    const self = await api.call('POST', `/devices/${device.id}/approve`, adminMobileToken, undefined, OFFICE_IP);
    expect(self.statusCode).toBe(403);
    expect(errorCode(self)).toBe('SELF_APPROVAL');

    expect((await api.call('POST', `/devices/${device.id}/approve`, sa)).statusCode).toBe(200);
  });

  it('is closed to those without the approval permission', async () => {
    const token = await api.signIn('counsellor', { office: true });
    expect((await api.call('GET', '/devices', token, undefined, OFFICE_IP)).statusCode).toBe(403);
  });

  it('pages through devices', async () => {
    for (const tail of ['p1', 'p2', 'p3']) await mobileLogin('perms', tail);
    const first = await api.call('GET', '/devices?status=all&limit=2', sa);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await api.call('GET', `/devices?status=all&limit=2&cursor=${first.json().nextCursor}`, sa);
    const ids = [...first.json().items, ...second.json().items].map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// A password known to be accepted, to keep the helper honest.
it('uses the fixture password', () => {
  expect(PASSWORD).toBe('Correct-horse-2026');
  expect(new PasswordService()).toBeDefined();
});
