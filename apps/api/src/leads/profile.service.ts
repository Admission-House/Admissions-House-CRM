import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { leadVisibility } from '../access/lead-scope.js';
import { LeadAccess } from './lead-access.js';
import { LeadWriter } from './lead-writer.js';
import { diffFields } from './lead-rules.js';
import type { UpdateProfileDto } from './profile.dto.js';

const SCALARS = [
  'alternate_email', 'date_of_birth', 'gender', 'category', 'current_location_id', 'preferred_year', 'preferred_level',
  'preferred_stream_id', 'budget_min', 'budget_max', 'loan_required',
] as const;

type Scalars = Record<(typeof SCALARS)[number], unknown>;

@Injectable()
export class ProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
  ) {}

  /**
   * Values already used on other leads for a free-text field, most used first, so a counsellor can
   * pick "CBSE" instead of typing it again. Only leads the person can see count.
   */
  suggestions(auth: AuthContext, field: 'board' | 'institution' | 'occupation' | 'exam'): Promise<string[]> {
    const source = {
      board: sql`SELECT e.board AS v, e.lead_id FROM lead_education e`,
      institution: sql`SELECT e.institution AS v, e.lead_id FROM lead_education e`,
      occupation: sql`SELECT g.occupation AS v, g.lead_id FROM lead_guardians g`,
      exam: sql`SELECT x.exam_name AS v, x.lead_id FROM lead_exams x`,
    }[field];
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const visible = leadVisibility(auth);
      const { rows } = await sql<{ v: string }>`
        SELECT s.v FROM (${source}) s JOIN leads l ON l.id = s.lead_id
        WHERE s.v IS NOT NULL AND btrim(s.v) <> '' AND l.deleted_at IS NULL ${visible ? sql`AND ${visible}` : sql``}
        GROUP BY s.v ORDER BY count(*) DESC, s.v LIMIT 100`.execute(trx);
      return rows.map((r) => r.v);
    });
  }

  get(auth: AuthContext, leadId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId);
      return this.read(trx, lead.id, lead.study_mode);
    });
  }

  update(auth: AuthContext, leadId: string, dto: UpdateProfileDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      await this.validate(trx, lead.id, lead.primary_phone, dto);

      await sql`INSERT INTO lead_profiles (tenant_id, lead_id) VALUES (${auth.tenantId}, ${lead.id}) ON CONFLICT (lead_id) DO NOTHING`.execute(trx);
      const before = await this.scalars(trx, lead.id);

      await this.writeScalars(trx, auth, lead.id, before, dto);
      if (dto.personal?.extraPhones) await this.replacePhones(trx, auth.tenantId, lead.id, dto.personal.extraPhones);
      if (dto.preferences?.preferredLocationIds) await this.replaceLocations(trx, auth.tenantId, lead.id, dto.preferences.preferredLocationIds);
      if (dto.guardians) await this.replaceGuardians(trx, auth.tenantId, lead.id, dto.guardians);
      if (dto.education) await this.replaceEducation(trx, auth.tenantId, lead.id, dto.education);
      if (dto.exams) await this.replaceExams(trx, auth.tenantId, lead.id, dto.exams);

      await this.recordHistory(trx, auth, lead.id, before, await this.scalars(trx, lead.id), dto);
      await sql`UPDATE leads SET updated_at = now(), updated_by = ${auth.userId} WHERE id = ${lead.id}`.execute(trx);
      return this.read(trx, lead.id, lead.study_mode);
    });
  }

  // ------------------------------------------------------------------- read

  private async read(trx: Trx, leadId: string, studyMode: string | null) {
    const { rows } = await sql<{
      alternate_email: string | null; date_of_birth: string | null; gender: string | null; category: string | null;
      loc_id: string | null; loc_name: string | null; loc_type: string | null; state_name: string | null;
      preferred_year: number | null; preferred_level: string | null; stream_id: string | null; stream_name: string | null;
      budget_min: number | null; budget_max: number | null; loan_required: boolean | null; updated_at: Date | null; updated_by: string | null;
    }>`
      SELECT p.alternate_email, p.date_of_birth::text AS date_of_birth, p.gender, p.category,
             loc.id AS loc_id, loc.name AS loc_name, loc.type AS loc_type, st.name AS state_name,
             p.preferred_year, p.preferred_level, sm.id AS stream_id, sm.name AS stream_name,
             p.budget_min::float8 AS budget_min, p.budget_max::float8 AS budget_max, p.loan_required, p.updated_at, ub.name AS updated_by
      FROM leads l
      LEFT JOIN lead_profiles p ON p.lead_id = l.id
      LEFT JOIN locations loc ON loc.id = p.current_location_id
      LEFT JOIN locations st ON st.id = loc.parent_id
      LEFT JOIN streams sm ON sm.id = p.preferred_stream_id
      LEFT JOIN users ub ON ub.id = p.updated_by
      WHERE l.id = ${leadId}`.execute(trx);
    const p = rows[0]!;

    const phones = await trx.selectFrom('lead_phones').select(['phone', 'label']).where('lead_id', '=', leadId).orderBy('phone').execute();
    const preferred = await sql<{ id: string; name: string; type: string }>`
      SELECT loc.id, loc.name, loc.type FROM lead_preferred_locations pl JOIN locations loc ON loc.id = pl.location_id
      WHERE pl.lead_id = ${leadId} ORDER BY loc.type DESC, loc.name`.execute(trx);
    const guardians = await trx.selectFrom('lead_guardians').select(['relation', 'name', 'phone', 'occupation']).where('lead_id', '=', leadId).orderBy('relation').execute();
    const education = await sql<{ level: string; marks_type: string | null; marks: number | null; institution: string | null; board: string | null; passing_year: number | null }>`
      SELECT level, marks_type, marks::float8 AS marks, institution, board, passing_year FROM lead_education WHERE lead_id = ${leadId}
      ORDER BY array_position(ARRAY['10th','12th','diploma','graduation','post_graduation'], level)`.execute(trx);
    const exams = await sql<{ exam_name: string; marks_type: string | null; score: number | null; exam_year: number | null }>`
      SELECT exam_name, marks_type, score::float8 AS score, exam_year FROM lead_exams WHERE lead_id = ${leadId} ORDER BY exam_year DESC NULLS LAST, exam_name`.execute(trx);

    return {
      personal: {
        alternateEmail: p.alternate_email, dateOfBirth: p.date_of_birth, gender: p.gender, category: p.category,
        currentLocation: p.loc_id ? { id: p.loc_id, name: p.loc_name!, type: p.loc_type!, state: p.state_name } : null,
        extraPhones: phones,
      },
      preferences: {
        studyMode, preferredYear: p.preferred_year, preferredLevel: p.preferred_level,
        preferredStream: p.stream_id ? { id: p.stream_id, name: p.stream_name! } : null,
        budgetMin: p.budget_min, budgetMax: p.budget_max, loanRequired: p.loan_required, preferredLocations: preferred.rows,
      },
      guardians,
      education: education.rows.map((e) => ({ level: e.level, marksType: e.marks_type, marks: e.marks, institution: e.institution, board: e.board, passingYear: e.passing_year })),
      exams: exams.rows.map((e) => ({ examName: e.exam_name, marksType: e.marks_type, score: e.score, examYear: e.exam_year })),
      updatedAt: p.updated_at, updatedBy: p.updated_by,
    };
  }

  // ------------------------------------------------------------------ write

  private async validate(trx: Trx, leadId: string, primaryPhone: string, dto: UpdateProfileDto): Promise<void> {
    const bad = (field: string, code: string, message: string) => AppError.badRequest(code, message, [{ field, message }]);

    const locationIds = [dto.personal?.currentLocationId, ...(dto.preferences?.preferredLocationIds ?? [])].filter((x): x is string => !!x);
    if (locationIds.length > 0) {
      const found = await trx.selectFrom('locations').select('id').where('id', 'in', [...new Set(locationIds)]).execute();
      if (found.length !== new Set(locationIds).size) throw bad('personal.currentLocationId', 'REFERENCE_INVALID', 'Choose states and cities from the list');
    }
    if (dto.preferences?.preferredStreamId) {
      const stream = await trx.selectFrom('streams').select('id').where('id', '=', dto.preferences.preferredStreamId).executeTakeFirst();
      if (!stream) throw bad('preferences.preferredStreamId', 'REFERENCE_INVALID', 'Choose a stream from the list');
    }

    const phones = dto.personal?.extraPhones?.map((p) => p.phone) ?? [];
    if (phones.includes(primaryPhone)) throw bad('personal.extraPhones', 'PHONE_IS_PRIMARY', 'That is already the lead\'s main number');
    if (phones.length > 0) {
      // A number belongs to one lead only, or the same person would turn up as two leads.
      const { rows } = await sql<{ lead_no: string }>`
        SELECT l.lead_no::text AS lead_no FROM leads l
        WHERE l.deleted_at IS NULL AND l.id <> ${leadId}
          AND (l.primary_phone = ANY(${phones}::text[])
               OR EXISTS (SELECT 1 FROM lead_phones x WHERE x.lead_id = l.id AND x.phone = ANY(${phones}::text[])))
        LIMIT 1`.execute(trx);
      if (rows[0]) throw AppError.conflict('PHONE_IN_USE', `A number you gave already belongs to lead ${rows[0].lead_no}`, { leadNo: rows[0].lead_no });
    }

    const min = dto.preferences?.budgetMin;
    const max = dto.preferences?.budgetMax;
    if (min !== undefined || max !== undefined) {
      const now = await this.scalars(trx, leadId);
      const lo = min !== undefined ? min : (now.budget_min as number | null);
      const hi = max !== undefined ? max : (now.budget_max as number | null);
      if (lo !== null && hi !== null && hi < lo) throw bad('preferences.budgetMax', 'BUDGET_INVALID', 'The highest budget cannot be below the lowest');
    }
  }

  private async scalars(trx: Trx, leadId: string): Promise<Scalars> {
    const { rows } = await sql<Scalars>`
      SELECT alternate_email, date_of_birth::text AS date_of_birth, gender, category, current_location_id, preferred_year,
             preferred_level, preferred_stream_id, budget_min::float8 AS budget_min, budget_max::float8 AS budget_max, loan_required
      FROM lead_profiles WHERE lead_id = ${leadId}`.execute(trx);
    return rows[0]!;
  }

  private async writeScalars(trx: Trx, auth: AuthContext, leadId: string, _before: Scalars, dto: UpdateProfileDto): Promise<void> {
    const p = dto.personal;
    const f = dto.preferences;
    const changes = {
      ...(p?.alternateEmail !== undefined && { alternate_email: p.alternateEmail }),
      ...(p?.dateOfBirth !== undefined && { date_of_birth: p.dateOfBirth }),
      ...(p?.gender !== undefined && { gender: p.gender }),
      ...(p?.category !== undefined && { category: p.category }),
      ...(p?.currentLocationId !== undefined && { current_location_id: p.currentLocationId }),
      ...(f?.preferredYear !== undefined && { preferred_year: f.preferredYear }),
      ...(f?.preferredLevel !== undefined && { preferred_level: f.preferredLevel }),
      ...(f?.preferredStreamId !== undefined && { preferred_stream_id: f.preferredStreamId }),
      ...(f?.budgetMin !== undefined && { budget_min: f.budgetMin }),
      ...(f?.budgetMax !== undefined && { budget_max: f.budgetMax }),
      ...(f?.loanRequired !== undefined && { loan_required: f.loanRequired }),
    };
    await trx.updateTable('lead_profiles').set({ ...changes, updated_by: auth.userId, updated_at: sql`now()` } as never).where('lead_id', '=', leadId).execute();
  }

  private async replacePhones(trx: Trx, tenantId: string, leadId: string, phones: { phone: string; label: string }[]) {
    await trx.deleteFrom('lead_phones').where('lead_id', '=', leadId).execute();
    if (phones.length) await trx.insertInto('lead_phones').values(phones.map((p) => ({ tenant_id: tenantId, lead_id: leadId, phone: p.phone, label: p.label }))).execute();
  }

  private async replaceLocations(trx: Trx, tenantId: string, leadId: string, ids: string[]) {
    await trx.deleteFrom('lead_preferred_locations').where('lead_id', '=', leadId).execute();
    if (ids.length) await trx.insertInto('lead_preferred_locations').values(ids.map((location_id) => ({ tenant_id: tenantId, lead_id: leadId, location_id }))).execute();
  }

  private async replaceGuardians(trx: Trx, tenantId: string, leadId: string, list: NonNullable<UpdateProfileDto['guardians']>) {
    await trx.deleteFrom('lead_guardians').where('lead_id', '=', leadId).execute();
    if (list.length) await trx.insertInto('lead_guardians').values(list.map((g) => ({ tenant_id: tenantId, lead_id: leadId, relation: g.relation, name: g.name, phone: g.phone, occupation: g.occupation }))).execute();
  }

  private async replaceEducation(trx: Trx, tenantId: string, leadId: string, list: NonNullable<UpdateProfileDto['education']>) {
    await trx.deleteFrom('lead_education').where('lead_id', '=', leadId).execute();
    if (list.length) {
      await trx.insertInto('lead_education').values(list.map((e) => ({
        tenant_id: tenantId, lead_id: leadId, level: e.level, marks_type: e.marksType, marks: e.marks, institution: e.institution, board: e.board, passing_year: e.passingYear,
      }))).execute();
    }
  }

  private async replaceExams(trx: Trx, tenantId: string, leadId: string, list: NonNullable<UpdateProfileDto['exams']>) {
    await trx.deleteFrom('lead_exams').where('lead_id', '=', leadId).execute();
    if (list.length) {
      await trx.insertInto('lead_exams').values(list.map((e) => ({
        tenant_id: tenantId, lead_id: leadId, exam_name: e.examName, marks_type: e.marksType, score: e.score, exam_year: e.examYear,
      }))).execute();
    }
  }

  /** One entry per changed detail, and one per list that was replaced. */
  private async recordHistory(trx: Trx, auth: AuthContext, leadId: string, before: Scalars, after: Scalars, dto: UpdateProfileDto): Promise<void> {
    for (const c of diffFields(before, after, SCALARS)) {
      await this.writer.activity(trx, { tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'field_change', field: `profile.${c.field}`, oldValue: c.oldValue, newValue: c.newValue });
    }
    const lists: [string, boolean][] = [
      ['extra_phones', !!dto.personal?.extraPhones], ['preferred_locations', !!dto.preferences?.preferredLocationIds],
      ['guardians', !!dto.guardians], ['education', !!dto.education], ['exams', !!dto.exams],
    ];
    for (const [name, replaced] of lists) {
      if (replaced) await this.writer.activity(trx, { tenantId: auth.tenantId, leadId, userId: auth.userId, type: 'field_change', field: `profile.${name}`, remark: 'Updated' });
    }
  }
}
