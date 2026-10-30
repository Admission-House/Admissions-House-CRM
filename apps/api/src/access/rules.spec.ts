import { AppError } from '../common/app-error.js';
import { decodeCursor, encodeCursor, toPage } from '../common/pagination.js';
import { z } from 'zod';
import { isInternalAddress, normalizeAllowedRange, rangeForAddress } from '../branches/network-rules.js';
import { assertCanGrant, assertRoleEditable } from '../roles/role-rules.js';
import { assertNotLastSuperAdmin, assertPlacement, PlacementInput } from '../users/user-rules.js';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'NOT_AN_APP_ERROR';
  }
  return undefined;
};

describe('assertCanGrant', () => {
  const held = new Set(['lead.read', 'lead.update']);
  it('allows granting what you hold', () => {
    expect(codeOf(() => assertCanGrant(held, ['lead.read']))).toBeUndefined();
    expect(codeOf(() => assertCanGrant(held, []))).toBeUndefined();
  });
  it('refuses granting anything you do not hold and names it', () => {
    expect(codeOf(() => assertCanGrant(held, ['lead.read', 'salary.write']))).toBe('PERMISSION_ESCALATION');
    expect(() => assertCanGrant(held, ['salary.write'])).toThrow(/salary\.write/);
  });
});

describe('assertRoleEditable', () => {
  it('never lets the Super Admin role change', () => {
    expect(codeOf(() => assertRoleEditable({ systemKey: 'super_admin', isSystem: true }, { permissions: true }))).toBe('ROLE_LOCKED');
  });
  it('lets a standard role change permissions but not name or visibility', () => {
    const admin = { systemKey: 'admin', isSystem: true };
    expect(codeOf(() => assertRoleEditable(admin, { permissions: true }))).toBeUndefined();
    expect(codeOf(() => assertRoleEditable(admin, { name: true }))).toBe('ROLE_LOCKED');
    expect(codeOf(() => assertRoleEditable(admin, { scope: true }))).toBe('ROLE_LOCKED');
  });
  it('lets a custom role change anything', () => {
    expect(codeOf(() => assertRoleEditable({ systemKey: null, isSystem: false }, { name: true, scope: true, permissions: true }))).toBeUndefined();
  });
});

describe('assertPlacement', () => {
  const counsellor = { systemKey: 'counsellor', requiresOffice: true, name: 'Counsellor' };
  const admin = { systemKey: 'admin', requiresOffice: true, name: 'Admin' };
  const superAdmin = { systemKey: 'super_admin', requiresOffice: false, name: 'Super Admin' };
  const base = (over: Partial<PlacementInput>): PlacementInput => ({
    role: counsellor, branchId: 'b1', managerId: 'm1', managerRoleKey: 'admin', ...over,
  });

  it('accepts a counsellor with an office and an Admin', () => {
    expect(codeOf(() => assertPlacement(base({})))).toBeUndefined();
  });
  it('needs an office for roles that sign in from the office', () => {
    expect(codeOf(() => assertPlacement(base({ branchId: null })))).toBe('BRANCH_REQUIRED');
    expect(codeOf(() => assertPlacement(base({ role: admin, branchId: null, managerId: null, managerRoleKey: null })))).toBe('BRANCH_REQUIRED');
  });
  it('needs a counsellor to report to an Admin, not to another counsellor or a Super Admin', () => {
    expect(codeOf(() => assertPlacement(base({ managerId: null, managerRoleKey: null })))).toBe('MANAGER_REQUIRED');
    expect(codeOf(() => assertPlacement(base({ managerRoleKey: 'counsellor' })))).toBe('MANAGER_INVALID');
    expect(codeOf(() => assertPlacement(base({ managerRoleKey: 'super_admin' })))).toBe('MANAGER_INVALID');
  });
  it('keeps a Super Admin at the top and without an office', () => {
    expect(codeOf(() => assertPlacement(base({ role: superAdmin, branchId: null, managerId: null, managerRoleKey: null })))).toBeUndefined();
    expect(codeOf(() => assertPlacement(base({ role: superAdmin, branchId: null })))).toBe('MANAGER_INVALID');
  });
  it('does not let anyone report to themselves', () => {
    expect(codeOf(() => assertPlacement(base({ userId: 'm1' })))).toBe('MANAGER_INVALID');
  });
});

describe('assertNotLastSuperAdmin', () => {
  it('needs another active Super Admin to remain', () => {
    expect(codeOf(() => assertNotLastSuperAdmin(0))).toBe('LAST_SUPER_ADMIN');
    expect(codeOf(() => assertNotLastSuperAdmin(1))).toBeUndefined();
  });
});

describe('normalizeAllowedRange', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5/32'],
    ['203.0.113.0/28', '203.0.113.0/28'],
    ['  10.20.0.0/16 ', '10.20.0.0/16'],
    ['2001:db8::1', '2001:db8::1/128'],
    ['2001:db8::/48', '2001:db8::/48'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeAllowedRange(input)).toBe(expected);
  });

  it.each(['0.0.0.0/0', '10.0.0.0/8', '203.0.113.0/15', '2001:db8::/32', '::/0'])(
    'refuses a range so wide that it switches the check off: %s',
    (input) => {
      expect(codeOf(() => normalizeAllowedRange(input))).toBe('NETWORK_INVALID');
    },
  );

  it.each(['', 'office', '999.1.1.1', '1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4/8x', '1.2.3.4/24/1', '1.2.3'])(
    'refuses a malformed value: %j',
    (input) => {
      expect(codeOf(() => normalizeAllowedRange(input))).toBe('NETWORK_INVALID');
    },
  );

  it('turns the address of a request into a single-address range, unwrapping IPv4-in-IPv6', () => {
    expect(rangeForAddress('203.0.113.9')).toBe('203.0.113.9/32');
    expect(rangeForAddress('::ffff:203.0.113.9')).toBe('203.0.113.9/32');
  });
});

describe('pagination', () => {
  const shape = z.object({ n: z.string(), i: z.string() });

  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor({ n: 'asha', i: '1' }), shape)).toEqual({ n: 'asha', i: '1' });
    expect(decodeCursor(undefined, shape)).toBeUndefined();
  });

  it.each(['not-base64-json', Buffer.from('{"n":1}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'refuses a damaged or forged cursor',
    (cursor) => {
      expect(codeOf(() => decodeCursor(cursor, shape))).toBe('INVALID_CURSOR');
    },
  );

  it('uses the extra row only to know whether more exist', () => {
    const rows = [1, 2, 3];
    const page = toPage(rows, 2, (n) => ({ n }));
    expect(page.items).toEqual([1, 2]);
    expect(page.nextCursor).not.toBeNull();
    expect(toPage([1, 2], 2, (n) => ({ n })).nextCursor).toBeNull();
    expect(toPage([], 2, (n) => ({ n })).nextCursor).toBeNull();
  });
});

describe('isInternalAddress', () => {
  it.each(['10.1.2.3', '127.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.20', '169.254.1.1', '::1', 'fd00::1', '::ffff:192.168.0.5'])(
    '%s is internal',
    (ip) => expect(isInternalAddress(ip)).toBe(true),
  );
  it.each(['203.0.113.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2001:db8::1'])('%s is public', (ip) =>
    expect(isInternalAddress(ip)).toBe(false),
  );
});
