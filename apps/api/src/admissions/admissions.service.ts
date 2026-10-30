import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import type { CreateShortlistDto, ListShortlistsDto, NiDnpDto, PaymentDto, UpdateShortlistDto } from './admissions.dto.js';

export interface ShortlistView {
  id: string;
  college: { id: string; name: string; location: string | null };
  formStatus: string;
  reconciliationStatus: string;
  payment: { status: string; amount: number | null; paidAt: Date | null };
  niDnp: { kind: string; reason: string | null } | null;
  courses: {
    collegeCourseId: string;
    course: { id: string; name: string; level: string };
    deliveryMode: string;
    cafFee: number | null;
    annualFee: number | null;
    durationYears: number | null;
  }[];
  shortlistedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string; college_id: string; college_name: string; location: string | null; form_status: string; reconciliation_status: string;
  payment_status: string; payment_amount: number | null; payment_at: Date | null; ni_dnp: string | null; ni_dnp_reason: string | null;
  shortlisted_by: string | null; created_at: Date; updated_at: Date;
}

/** Colleges recommended to a student, the ones they shortlist, and how each application is going. */
@Injectable()
export class AdmissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
  ) {}

  // -------------------------------------------------------- recommendations

  recommendations(auth: AuthContext, leadId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const { rows } = await sql<{ id: string; name: string; location: string | null; by: string | null; created_at: Date; shortlisted: boolean }>`
        SELECT c.id, c.name, loc.name AS location, u.name AS by, r.created_at,
               EXISTS (SELECT 1 FROM lead_shortlists s WHERE s.lead_id = r.lead_id AND s.college_id = r.college_id) AS shortlisted
        FROM lead_recommendations r
        JOIN colleges c ON c.id = r.college_id
        LEFT JOIN locations loc ON loc.id = c.location_id
        LEFT JOIN users u ON u.id = r.recommended_by
        WHERE r.lead_id = ${leadId} ORDER BY r.created_at DESC`.execute(trx);
      return rows.map((r) => ({ college: { id: r.id, name: r.name, location: r.location }, recommendedBy: r.by, at: r.created_at, shortlisted: r.shortlisted }));
    });
  }

  recommend(auth: AuthContext, leadId: string, collegeId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      const college = await this.college(trx, collegeId);
      const exists = await trx.selectFrom('lead_recommendations').select('id').where('lead_id', '=', lead.id).where('college_id', '=', collegeId).executeTakeFirst();
      if (exists) throw AppError.conflict('ALREADY_RECOMMENDED', 'This institute is already recommended to the student');
      await trx.insertInto('lead_recommendations').values({ tenant_id: auth.tenantId, lead_id: lead.id, college_id: collegeId, recommended_by: auth.userId }).execute();
      await this.log(trx, auth, lead.id, 'recommended', null, college.name);
      return { collegeId, recommended: true as const };
    });
  }

  unrecommend(auth: AuthContext, leadId: string, collegeId: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      const removed = await trx.deleteFrom('lead_recommendations').where('lead_id', '=', lead.id).where('college_id', '=', collegeId).returning('id').executeTakeFirst();
      if (!removed) throw AppError.notFound('Recommendation');
      await this.log(trx, auth, lead.id, 'recommended', (await this.college(trx, collegeId)).name, null);
    });
  }

  // ------------------------------------------------------------- shortlists

  list(auth: AuthContext, leadId: string, query: ListShortlistsDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      return this.load(trx, leadId, undefined, query.view);
    });
  }

  create(auth: AuthContext, leadId: string, dto: CreateShortlistDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      const college = await this.college(trx, dto.collegeId);
      const existing = await trx.selectFrom('lead_shortlists').select('id').where('lead_id', '=', lead.id).where('college_id', '=', dto.collegeId).executeTakeFirst();
      if (existing) throw AppError.conflict('ALREADY_SHORTLISTED', 'This institute is already shortlisted', { shortlistId: existing.id });
      await this.assertCoursesBelong(trx, dto.collegeId, dto.collegeCourseIds);

      const row = await trx
        .insertInto('lead_shortlists')
        .values({ tenant_id: auth.tenantId, lead_id: lead.id, college_id: dto.collegeId, shortlisted_by: auth.userId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.setCourses(trx, auth.tenantId, row.id, dto.collegeCourseIds);
      await this.log(trx, auth, lead.id, 'shortlisted', null, college.name);
      return (await this.load(trx, lead.id, row.id))[0]!;
    });
  }

  update(auth: AuthContext, leadId: string, shortlistId: string, dto: UpdateShortlistDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (row.ni_dnp) throw AppError.conflict('SHORTLIST_CLOSED', `Marked ${row.ni_dnp.toUpperCase()}. Clear that first to change the application.`);

      if (dto.collegeCourseIds) {
        await this.assertCoursesBelong(trx, row.college_id, dto.collegeCourseIds);
        await this.setCourses(trx, auth.tenantId, shortlistId, dto.collegeCourseIds);
        await this.log(trx, auth, lead.id, 'courses', null, `${dto.collegeCourseIds.length} course(s) at ${row.college_name}`);
      }
      const changes = {
        ...(dto.formStatus !== undefined && { form_status: dto.formStatus }),
        ...(dto.reconciliationStatus !== undefined && { reconciliation_status: dto.reconciliationStatus }),
      };
      if (Object.keys(changes).length > 0) await trx.updateTable('lead_shortlists').set(changes).where('id', '=', shortlistId).execute();
      if (dto.formStatus !== undefined && dto.formStatus !== row.form_status) await this.log(trx, auth, lead.id, 'form_status', row.form_status, dto.formStatus, row.college_name);
      if (dto.reconciliationStatus !== undefined && dto.reconciliationStatus !== row.reconciliation_status) {
        await this.log(trx, auth, lead.id, 'reconciliation_status', row.reconciliation_status, dto.reconciliationStatus, row.college_name);
      }
      return (await this.load(trx, lead.id, shortlistId))[0]!;
    });
  }

  remove(auth: AuthContext, leadId: string, shortlistId: string): Promise<void> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (row.payment_status === 'completed') throw AppError.conflict('HAS_PAYMENT', 'A payment is recorded for this institute, so it cannot be removed');
      await trx.deleteFrom('lead_shortlists').where('id', '=', shortlistId).execute();
      await this.log(trx, auth, lead.id, 'shortlisted', row.college_name, null);
    });
  }

  // ---------------------------------------------------------------- payment

  /** Records that the application fee was paid. Recording again corrects the amount or date. */
  recordPayment(auth: AuthContext, leadId: string, shortlistId: string, dto: PaymentDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (row.ni_dnp) throw AppError.conflict('SHORTLIST_CLOSED', `Marked ${row.ni_dnp.toUpperCase()}, so a payment cannot be recorded`);
      const paidAt = dto.paidAt ?? new Date();
      if (paidAt.getTime() > Date.now() + 60_000) {
        throw AppError.badRequest('PAID_IN_FUTURE', 'The payment date cannot be in the future', [{ field: 'paidAt', message: 'Choose today or an earlier day' }]);
      }
      await trx.updateTable('lead_shortlists').set({ payment_status: 'completed', payment_amount: dto.amount, payment_at: paidAt }).where('id', '=', shortlistId).execute();
      await this.log(trx, auth, lead.id, 'payment', row.payment_amount === null ? null : String(row.payment_amount), String(dto.amount), row.college_name);
      return (await this.load(trx, lead.id, shortlistId))[0]!;
    });
  }

  clearPayment(auth: AuthContext, leadId: string, shortlistId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (row.payment_status !== 'completed') throw AppError.conflict('NO_PAYMENT', 'No payment is recorded');
      await trx.updateTable('lead_shortlists').set({ payment_status: 'pending', payment_amount: null, payment_at: null }).where('id', '=', shortlistId).execute();
      await this.log(trx, auth, lead.id, 'payment', String(row.payment_amount), null, row.college_name);
      return (await this.load(trx, lead.id, shortlistId))[0]!;
    });
  }

  // ------------------------------------------------------------------ NI/DNP

  markNiDnp(auth: AuthContext, leadId: string, shortlistId: string, dto: NiDnpDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (row.payment_status === 'completed') throw AppError.conflict('ALREADY_PAID', 'A payment is recorded for this institute, so it cannot be marked NI or DNP');
      await trx.updateTable('lead_shortlists').set({ ni_dnp: dto.kind, ni_dnp_reason: dto.reason }).where('id', '=', shortlistId).execute();
      await this.log(trx, auth, lead.id, 'ni_dnp', row.ni_dnp, dto.kind, row.college_name, dto.reason);
      return (await this.load(trx, lead.id, shortlistId))[0]!;
    });
  }

  clearNiDnp(auth: AuthContext, leadId: string, shortlistId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { lead, row } = await this.lock(trx, auth, leadId, shortlistId);
      if (!row.ni_dnp) throw AppError.conflict('NOT_MARKED', 'This institute is not marked NI or DNP');
      await trx.updateTable('lead_shortlists').set({ ni_dnp: null, ni_dnp_reason: null }).where('id', '=', shortlistId).execute();
      await this.log(trx, auth, lead.id, 'ni_dnp', row.ni_dnp, null, row.college_name);
      return (await this.load(trx, lead.id, shortlistId))[0]!;
    });
  }

  // ---------------------------------------------------------------- helpers

  private async load(trx: Trx, leadId: string, shortlistId?: string, view: ListShortlistsDto['view'] = 'all'): Promise<ShortlistView[]> {
    const filter = {
      all: sql`true`, active: sql`s.ni_dnp IS NULL`, ni_dnp: sql`s.ni_dnp IS NOT NULL`, reconciled: sql`s.reconciliation_status = 'reconciled'`,
    }[view];
    const { rows } = await sql<Row>`
      SELECT s.id, s.college_id, c.name AS college_name, loc.name AS location, s.form_status, s.reconciliation_status, s.payment_status,
             s.payment_amount::float8 AS payment_amount, s.payment_at, s.ni_dnp, s.ni_dnp_reason, u.name AS shortlisted_by, s.created_at, s.updated_at
      FROM lead_shortlists s
      JOIN colleges c ON c.id = s.college_id
      LEFT JOIN locations loc ON loc.id = c.location_id
      LEFT JOIN users u ON u.id = s.shortlisted_by
      WHERE s.lead_id = ${leadId} AND ${filter} ${shortlistId ? sql`AND s.id = ${shortlistId}` : sql``}
      ORDER BY s.created_at`.execute(trx);
    if (rows.length === 0) return [];

    const { rows: courses } = await sql<{
      shortlist_id: string; id: string; delivery_mode: string; caf_fee: number | null; annual_fee: number | null; duration_years: number | null;
      course_id: string; course_name: string; level: string;
    }>`
      SELECT sc.shortlist_id, cc.id, cc.delivery_mode, cc.caf_fee::float8 AS caf_fee, cc.annual_fee::float8 AS annual_fee,
             cc.duration_years::float8 AS duration_years, c.id AS course_id, c.name AS course_name, c.level
      FROM lead_shortlist_courses sc JOIN college_courses cc ON cc.id = sc.college_course_id JOIN courses c ON c.id = cc.course_id
      WHERE sc.shortlist_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY c.name`.execute(trx);

    return rows.map((r) => ({
      id: r.id,
      college: { id: r.college_id, name: r.college_name, location: r.location },
      formStatus: r.form_status,
      reconciliationStatus: r.reconciliation_status,
      payment: { status: r.payment_status, amount: r.payment_amount, paidAt: r.payment_at },
      niDnp: r.ni_dnp ? { kind: r.ni_dnp, reason: r.ni_dnp_reason } : null,
      courses: courses.filter((c) => c.shortlist_id === r.id).map((c) => ({
        collegeCourseId: c.id, course: { id: c.course_id, name: c.course_name, level: c.level }, deliveryMode: c.delivery_mode,
        cafFee: c.caf_fee, annualFee: c.annual_fee, durationYears: c.duration_years,
      })),
      shortlistedBy: r.shortlisted_by, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  /** The lead (held) and one of its shortlisted institutes (held), or a 404. */
  private async lock(trx: Trx, auth: AuthContext, leadId: string, shortlistId: string) {
    const lead = await this.access.get(trx, auth, leadId, true);
    const { rows } = await sql<Row>`
      SELECT s.id, s.college_id, c.name AS college_name, NULL::text AS location, s.form_status, s.reconciliation_status, s.payment_status,
             s.payment_amount::float8 AS payment_amount, s.payment_at, s.ni_dnp, s.ni_dnp_reason, NULL::text AS shortlisted_by,
             s.created_at, s.updated_at
      FROM lead_shortlists s JOIN colleges c ON c.id = s.college_id
      WHERE s.id = ${shortlistId} AND s.lead_id = ${lead.id} FOR UPDATE OF s`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Shortlisted institute');
    return { lead, row: rows[0] };
  }

  private async college(trx: Trx, id: string): Promise<{ id: string; name: string }> {
    const row = await trx.selectFrom('colleges').select(['id', 'name', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!row || !row.is_active) {
      throw AppError.badRequest('COLLEGE_INVALID', 'Choose an institute from the list', [{ field: 'collegeId', message: 'Choose an institute that is in use' }]);
    }
    return row;
  }

  /** Every chosen course must be one that institute offers right now. */
  private async assertCoursesBelong(trx: Trx, collegeId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await trx.selectFrom('college_courses').select('id').where('college_id', '=', collegeId).where('is_active', '=', true).where('id', 'in', ids).execute();
    if (found.length !== ids.length) {
      throw AppError.badRequest('COURSE_NOT_OFFERED', 'Some of the courses are not offered by this institute', [{ field: 'collegeCourseIds', message: 'Choose courses from this institute\'s list' }]);
    }
  }

  private async setCourses(trx: Trx, tenantId: string, shortlistId: string, ids: string[]): Promise<void> {
    await trx.deleteFrom('lead_shortlist_courses').where('shortlist_id', '=', shortlistId).execute();
    if (ids.length) await trx.insertInto('lead_shortlist_courses').values(ids.map((college_course_id) => ({ tenant_id: tenantId, shortlist_id: shortlistId, college_course_id }))).execute();
    await sql`UPDATE lead_shortlists SET updated_at = now() WHERE id = ${shortlistId}`.execute(trx);
  }

  private log(trx: Trx, auth: AuthContext, leadId: string, field: string, oldValue: string | null, newValue: string | null, college?: string, remark?: string) {
    return this.writer.activity(trx, {
      tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'shortlist', field, oldValue, newValue,
      remark: remark ?? (college ? `At ${college}` : null),
    });
  }
}
