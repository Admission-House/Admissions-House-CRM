import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { calendarDate } from '../common/dates.js';
import { normalizePhone } from '../common/phone.js';
import { SecretBox } from '../crypto/secret-box.js';
import { DatabaseService, Trx } from '../database/database.service.js';

const text = (max: number) => z.string().trim().max(max);
const phone = z.string().trim().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) ctx.addIssue({ code: 'custom', message: 'Enter a valid mobile number' });
  return n ?? z.NEVER;
});

/** What a person may change about themselves. */
const selfFields = {
  address: text(500).nullable(),
  emergencyContactName: text(80).nullable(),
  emergencyContactPhone: phone.nullable(),
  bankName: text(80).nullable(),
  bankAccountNo: z.string().trim().regex(/^\d{6,20}$/, 'Account number is 6 to 20 digits').nullable(),
  bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234').nullable(),
};
export const selfProfileSchema = z.object(selfFields).strict().partial().refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
/** What someone who manages people may change: the above and the HR details. */
export const staffProfileSchema = z.object({ ...selfFields, designation: text(80).nullable(), dateOfBirth: calendarDate.nullable() }).partial().refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export type ProfileChange = z.infer<typeof staffProfileSchema>;

export interface ProfileView {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  joinedOn: string | null;
  designation: string | null;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  bankName: string | null;
  /** Only the last four digits, unless the full number was asked for. */
  bankAccountNo: string | null;
  bankIfsc: string | null;
}

interface Row {
  id: string; name: string; email: string; phone: string | null; joined_on: string | null; designation: string | null; date_of_birth: string | null;
  address: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; bank_name: string | null;
  bank_account_no_enc: string | null; bank_ifsc_enc: string | null;
}

const context = (tenantId: string, userId: string, field: string) => `profile:${tenantId}:${userId}:${field}`;

/**
 * Employee details beyond the login: HR details, an emergency contact and bank details. The account
 * number and IFSC are encrypted before they are stored; they are shown masked, and shown in full only
 * to the person themselves or to someone who enters salaries for them, with a note in the audit log.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly box: SecretBox,
    private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext, userId: string, reveal = false): Promise<ProfileView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.reachable(trx, auth, userId);
      const row = await this.row(trx, userId);
      const full = reveal && (userId === auth.userId || auth.permissions.has('salary.write'));
      if (reveal && !full) throw AppError.forbidden();
      if (reveal && row.bank_account_no_enc) {
        await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'profile.reveal_bank', entity: 'user', entityId: userId, ip: auth.ip, requestId: auth.requestId });
      }
      return this.toView(auth.tenantId, row, full);
    });
  }

  update(auth: AuthContext, userId: string, change: ProfileChange): Promise<ProfileView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const own = userId === auth.userId;
      if (!own) await this.reachable(trx, auth, userId);
      const hrFields = ['designation', 'dateOfBirth'] as const;
      if (hrFields.some((f) => f in change) && !auth.permissions.has('user.manage')) throw AppError.forbidden();
      if (!own && !auth.permissions.has('user.manage')) throw AppError.forbidden();

      const before = await this.row(trx, userId);
      const set: Record<string, string | null> = {};
      if ('designation' in change) set.designation = change.designation ?? null;
      if ('dateOfBirth' in change) set.date_of_birth = change.dateOfBirth ?? null;
      if ('address' in change) set.address = change.address ?? null;
      if ('emergencyContactName' in change) set.emergency_contact_name = change.emergencyContactName ?? null;
      if ('emergencyContactPhone' in change) set.emergency_contact_phone = change.emergencyContactPhone ?? null;
      if ('bankName' in change) set.bank_name = change.bankName ?? null;
      if ('bankAccountNo' in change) set.bank_account_no_enc = change.bankAccountNo ? this.box.seal(change.bankAccountNo, context(auth.tenantId, userId, 'account')) : null;
      if ('bankIfsc' in change) set.bank_ifsc_enc = change.bankIfsc ? this.box.seal(change.bankIfsc, context(auth.tenantId, userId, 'ifsc')) : null;

      await trx
        .insertInto('user_profiles')
        .values({ tenant_id: auth.tenantId, user_id: userId, ...set } as never)
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ ...set, updated_at: sql`now()` } as never))
        .execute();
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'profile.update', entity: 'user', entityId: userId,
        before: this.safe(before), after: Object.fromEntries(Object.keys(change).map((k) => [k, k.startsWith('bank') && k !== 'bankName' ? '(changed)' : (change as Record<string, unknown>)[k]])),
        ip: auth.ip, requestId: auth.requestId,
      });
      return this.toView(auth.tenantId, await this.row(trx, userId), false);
    });
  }

  // ----------------------------------------------------------------- inner

  private async reachable(trx: Trx, auth: AuthContext, userId: string): Promise<void> {
    if (userId === auth.userId) return;
    if (!auth.permissions.has('user.read')) throw AppError.forbidden();
    const scoped = scopeCondition(auth, 'u.id');
    const { rows } = await sql<{ id: string }>`SELECT u.id FROM users u WHERE u.id = ${userId}::uuid ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('User');
  }

  private async row(trx: Trx, userId: string): Promise<Row> {
    const { rows } = await sql<Row>`
      SELECT u.id, u.name, u.email::text AS email, u.phone, u.joined_on::text AS joined_on, p.designation, p.date_of_birth::text AS date_of_birth, p.address,
             p.emergency_contact_name, p.emergency_contact_phone, p.bank_name, p.bank_account_no_enc, p.bank_ifsc_enc
      FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ${userId}::uuid`.execute(trx);
    if (!rows[0]) throw AppError.notFound('User');
    return rows[0];
  }

  private toView(tenantId: string, r: Row, full: boolean): ProfileView {
    const account = r.bank_account_no_enc ? this.box.open(r.bank_account_no_enc, context(tenantId, r.id, 'account')) : null;
    return {
      userId: r.id, name: r.name, email: r.email, phone: r.phone, joinedOn: r.joined_on, designation: r.designation, dateOfBirth: r.date_of_birth, address: r.address,
      emergencyContactName: r.emergency_contact_name, emergencyContactPhone: r.emergency_contact_phone, bankName: r.bank_name,
      bankAccountNo: account && (full ? account : `${'*'.repeat(Math.max(0, account.length - 4))}${account.slice(-4)}`),
      bankIfsc: r.bank_ifsc_enc ? this.box.open(r.bank_ifsc_enc, context(tenantId, r.id, 'ifsc')) : null,
    };
  }

  /** The profile as it is written to the audit log: no bank numbers. */
  private safe(r: Row) {
    return { designation: r.designation, dateOfBirth: r.date_of_birth, address: r.address, emergencyContactName: r.emergency_contact_name, emergencyContactPhone: r.emergency_contact_phone, bankName: r.bank_name, hasBankAccount: !!r.bank_account_no_enc };
  }
}
