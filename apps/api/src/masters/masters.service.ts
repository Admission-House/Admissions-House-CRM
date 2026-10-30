import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { likePattern } from '../leads/lead-rules.js';
import type {
  CreateCollegeDto, CreateCourseDto, CreateStreamDto, ListCollegesDto, ListCoursesDto, ListLocationsDto, SetOfferedCourseDto,
  UpdateCollegeDto, UpdateCourseDto,
} from './masters.dto.js';

export interface CollegeListItem {
  id: string;
  name: string;
  location: { id: string; name: string; type: string; state: string | null } | null;
  isActive: boolean;
  /** Added by hand and not yet reviewed by an Admin. */
  pendingReview: boolean;
  courseCount: number;
  offersOnline: boolean;
  offersRegular: boolean;
}

export interface OfferedCourse {
  id: string;
  course: { id: string; name: string; level: string; stream: string | null };
  deliveryMode: string;
  cafFee: number | null;
  annualFee: number | null;
  durationYears: number | null;
  isActive: boolean;
}

const nameCursor = z.object({ n: z.string(), i: z.string() });

/** Colleges, courses, streams and places: the lists counsellors choose from. */
@Injectable()
export class MastersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly access: LeadAccess,
  ) {}

  // -------------------------------------------------------------- the lists

  locations(auth: AuthContext, q: ListLocationsDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const conditions = [sql<SqlBool>`true`];
      if (q.type) conditions.push(sql<SqlBool>`l.type = ${q.type}`);
      if (q.parentId) conditions.push(sql<SqlBool>`l.parent_id = ${q.parentId}::uuid`);
      if (q.q) conditions.push(sql<SqlBool>`l.name ILIKE ${likePattern(q.q)}`);
      const { rows } = await sql<{ id: string; name: string; type: string; parent_id: string | null; state: string | null }>`
        SELECT l.id, l.name, l.type, l.parent_id, p.name AS state
        FROM locations l LEFT JOIN locations p ON p.id = l.parent_id
        WHERE ${sql.join(conditions, sql` AND `)} ORDER BY l.type DESC, l.name LIMIT ${q.limit}`.execute(trx);
      return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, parentId: r.parent_id, state: r.state }));
    });
  }

  streams(auth: AuthContext) {
    return this.db.withTenant(auth.tenantId, (trx) => trx.selectFrom('streams').select(['id', 'name']).orderBy('name').execute());
  }

  createStream(auth: AuthContext, dto: CreateStreamDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const taken = await trx.selectFrom('streams').select('id').where(sql`lower(name)`, '=', dto.name.toLowerCase()).executeTakeFirst();
      if (taken) throw AppError.conflict('STREAM_EXISTS', 'A stream with this name already exists');
      const row = await trx.insertInto('streams').values({ tenant_id: auth.tenantId, name: dto.name }).returning(['id', 'name']).executeTakeFirstOrThrow();
      await this.record(trx, auth, 'stream.create', 'stream', row.id, undefined, dto);
      return row;
    });
  }

  courses(auth: AuthContext, q: ListCoursesDto): Promise<Page<CourseView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(q.cursor, nameCursor);
      const c = [sql<SqlBool>`true`];
      if (!auth.permissions.has('master.manage')) c.push(sql<SqlBool>`c.is_active`);
      if (q.q) c.push(sql<SqlBool>`c.name ILIKE ${likePattern(q.q)}`);
      if (q.level) c.push(sql<SqlBool>`c.level = ${q.level}`);
      if (q.streamId) c.push(sql<SqlBool>`c.stream_id = ${q.streamId}::uuid`);
      if (after) c.push(sql<SqlBool>`(lower(c.name), c.id) > (${after.n}, ${after.i}::uuid)`);
      const { rows } = await sql<CourseRow>`
        SELECT c.id, c.name, c.level, c.is_active, s.id AS stream_id, s.name AS stream_name, lower(c.name) AS sort_name
        FROM courses c LEFT JOIN streams s ON s.id = c.stream_id
        WHERE ${sql.join(c, sql` AND `)} ORDER BY lower(c.name), c.id LIMIT ${q.limit + 1}`.execute(trx);
      const page = toPage(rows, q.limit, (last) => ({ n: last.sort_name, i: last.id }));
      return { items: page.items.map(toCourse), nextCursor: page.nextCursor };
    });
  }

  createCourse(auth: AuthContext, dto: CreateCourseDto): Promise<CourseView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const id = await this.insertCourse(trx, auth, dto);
      await this.record(trx, auth, 'course.create', 'course', id, undefined, dto);
      return this.course(trx, id);
    });
  }

  updateCourse(auth: AuthContext, id: string, dto: UpdateCourseDto): Promise<CourseView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.course(trx, id);
      if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) await this.assertCourseNameFree(trx, dto.name);
      if (dto.streamId) await this.assertStream(trx, dto.streamId);
      const changes = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.level !== undefined && { level: dto.level }),
        ...(dto.streamId !== undefined && { stream_id: dto.streamId }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      };
      if (Object.keys(changes).length > 0) await trx.updateTable('courses').set(changes).where('id', '=', id).execute();
      const after = await this.course(trx, id);
      await this.record(trx, auth, 'course.update', 'course', id, before, after);
      return after;
    });
  }

  colleges(auth: AuthContext, q: ListCollegesDto): Promise<Page<CollegeListItem>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(q.cursor, nameCursor);
      const mode = await this.effectiveMode(trx, auth, q);
      const delivered = mode === 'online' ? sql`cc.delivery_mode IN ('online', 'both')` : mode === 'regular' ? sql`cc.delivery_mode IN ('regular', 'both')` : sql`true`;

      const c = [sql<SqlBool>`true`];
      if (q.pendingReview) {
        if (!auth.permissions.has('master.review')) throw AppError.forbidden();
        c.push(sql<SqlBool>`(c.is_manual AND c.reviewed_at IS NULL)`);
      } else if (!auth.permissions.has('master.manage')) {
        c.push(sql<SqlBool>`c.is_active`);
      }
      if (q.q) c.push(sql<SqlBool>`c.name ILIKE ${likePattern(q.q)}`);
      if (q.locationId) c.push(sql<SqlBool>`(loc.id = ${q.locationId}::uuid OR loc.parent_id = ${q.locationId}::uuid)`);
      if (q.courseId) c.push(sql<SqlBool>`EXISTS (SELECT 1 FROM college_courses cc WHERE cc.college_id = c.id AND cc.is_active AND cc.course_id = ${q.courseId}::uuid AND ${delivered})`);
      else if (mode !== 'any') c.push(sql<SqlBool>`EXISTS (SELECT 1 FROM college_courses cc WHERE cc.college_id = c.id AND cc.is_active AND ${delivered})`);
      if (after) c.push(sql<SqlBool>`(lower(c.name), c.id) > (${after.n}, ${after.i}::uuid)`);

      const { rows } = await sql<{
        id: string; name: string; is_active: boolean; pending: boolean; loc_id: string | null; loc_name: string | null; loc_type: string | null;
        state: string | null; course_count: string; online: boolean; regular: boolean; sort_name: string;
      }>`
        SELECT c.id, c.name, c.is_active, (c.is_manual AND c.reviewed_at IS NULL) AS pending, loc.id AS loc_id, loc.name AS loc_name,
               loc.type AS loc_type, st.name AS state, lower(c.name) AS sort_name,
               (SELECT count(*) FROM college_courses cc WHERE cc.college_id = c.id AND cc.is_active AND ${delivered}) AS course_count,
               EXISTS (SELECT 1 FROM college_courses cc WHERE cc.college_id = c.id AND cc.is_active AND cc.delivery_mode IN ('online', 'both')) AS online,
               EXISTS (SELECT 1 FROM college_courses cc WHERE cc.college_id = c.id AND cc.is_active AND cc.delivery_mode IN ('regular', 'both')) AS regular
        FROM colleges c
        LEFT JOIN locations loc ON loc.id = c.location_id
        LEFT JOIN locations st ON st.id = loc.parent_id
        WHERE ${sql.join(c, sql` AND `)}
        ORDER BY lower(c.name), c.id LIMIT ${q.limit + 1}`.execute(trx);
      const page = toPage(rows, q.limit, (last) => ({ n: last.sort_name, i: last.id }));
      return {
        items: page.items.map((r) => ({
          id: r.id, name: r.name, isActive: r.is_active, pendingReview: r.pending,
          location: r.loc_id ? { id: r.loc_id, name: r.loc_name!, type: r.loc_type!, state: r.state } : null,
          courseCount: Number(r.course_count), offersOnline: r.online, offersRegular: r.regular,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  college(auth: AuthContext, id: string, mode: 'online' | 'regular' | 'any' = 'any') {
    return this.db.withTenant(auth.tenantId, (trx) => this.collegeView(trx, auth, id, mode));
  }

  /** One institute with its courses, read in the caller's transaction so it can show what was just written. */
  private async collegeView(trx: Trx, auth: AuthContext, id: string, mode: 'online' | 'regular' | 'any' = 'any') {
    const { rows } = await sql<{ id: string; name: string; is_active: boolean; pending: boolean; loc_id: string | null; loc_name: string | null; loc_type: string | null; state: string | null }>`
      SELECT c.id, c.name, c.is_active, (c.is_manual AND c.reviewed_at IS NULL) AS pending,
             loc.id AS loc_id, loc.name AS loc_name, loc.type AS loc_type, st.name AS state
      FROM colleges c LEFT JOIN locations loc ON loc.id = c.location_id LEFT JOIN locations st ON st.id = loc.parent_id
      WHERE c.id = ${id}`.execute(trx);
    const r = rows[0];
    // A switched-off or turned-down institute is still visible to those who manage or review the lists.
    const seesInactive = auth.permissions.has('master.manage') || auth.permissions.has('master.review');
    if (!r || (!r.is_active && !seesInactive)) throw AppError.notFound('College');
    return {
      id: r.id, name: r.name, isActive: r.is_active, pendingReview: r.pending,
      location: r.loc_id ? { id: r.loc_id, name: r.loc_name!, type: r.loc_type!, state: r.state } : null,
      courses: await this.offered(trx, id, mode, auth.permissions.has('master.manage')),
    };
  }

  // --------------------------------------------------------------- writing

  /**
   * Adds an institute. Someone who manages the lists adds it for good; a counsellor who cannot
   * find an institute can add it too, and it is flagged for an Admin to review (see PRO-16).
   */
  createCollege(auth: AuthContext, dto: CreateCollegeDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const manager = auth.permissions.has('master.manage');
      if (!manager && !auth.permissions.has('master.create')) throw AppError.forbidden();
      await this.assertLocation(trx, dto.locationId);
      await this.assertCollegeFree(trx, dto.name, dto.locationId ?? null);

      const row = await trx
        .insertInto('colleges')
        .values({
          tenant_id: auth.tenantId, name: dto.name, location_id: dto.locationId ?? null, is_manual: !manager, created_by: auth.userId,
          ...(manager && { reviewed_by: auth.userId, reviewed_at: sql`now()` }),
        } as never)
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const offered of dto.courses) {
        const courseId = offered.courseId ?? (await this.courseForNewName(trx, auth, offered.newCourse!));
        await this.upsertOffered(trx, auth.tenantId, row.id, courseId, offered);
      }
      await this.record(trx, auth, 'college.create', 'college', row.id, undefined, { name: dto.name, manual: !manager, courses: dto.courses.length });
      return this.collegeView(trx, auth, row.id);
    });
  }

  updateCollege(auth: AuthContext, id: string, dto: UpdateCollegeDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await trx.selectFrom('colleges').select(['name', 'location_id', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!before) throw AppError.notFound('College');
      if (dto.locationId) await this.assertLocation(trx, dto.locationId);
      const name = dto.name ?? before.name;
      const location = dto.locationId !== undefined ? dto.locationId : before.location_id;
      if (dto.name !== undefined || dto.locationId !== undefined) await this.assertCollegeFree(trx, name, location, id);

      const changes = {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.locationId !== undefined && { location_id: dto.locationId }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      };
      await trx.updateTable('colleges').set(changes).where('id', '=', id).execute();
      await this.record(trx, auth, 'college.update', 'college', id, before, changes);
      return this.collegeView(trx, auth, id);
    });
  }

  setOfferedCourse(auth: AuthContext, collegeId: string, courseId: string, dto: SetOfferedCourseDto) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.requireCollege(trx, collegeId);
      await this.course(trx, courseId);
      await this.upsertOffered(trx, auth.tenantId, collegeId, courseId, dto);
      await this.record(trx, auth, 'college_course.set', 'college', collegeId, undefined, { courseId, ...dto });
      return this.collegeView(trx, auth, collegeId);
    });
  }

  removeOfferedCourse(auth: AuthContext, collegeId: string, courseId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx.selectFrom('college_courses').select('id').where('college_id', '=', collegeId).where('course_id', '=', courseId).executeTakeFirst();
      if (!row) throw AppError.notFound('Course at this college');
      const used = await trx.selectFrom('lead_shortlist_courses').select('shortlist_id').where('college_course_id', '=', row.id).limit(1).executeTakeFirst();
      if (used) throw AppError.conflict('COURSE_IN_USE', 'Students have shortlisted this course. Switch it off instead of removing it.');
      await trx.deleteFrom('college_courses').where('id', '=', row.id).execute();
      await this.record(trx, auth, 'college_course.remove', 'college', collegeId, { courseId }, undefined);
      return this.collegeView(trx, auth, collegeId);
    });
  }

  /** An Admin approves or turns down an institute a counsellor added by hand. */
  review(auth: AuthContext, id: string, decision: 'approved' | 'rejected') {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await trx.selectFrom('colleges').select(['is_manual', 'reviewed_at']).where('id', '=', id).executeTakeFirst();
      if (!row) throw AppError.notFound('College');
      if (!row.is_manual || row.reviewed_at) throw AppError.conflict('NOT_PENDING', 'This institute is not waiting for review');
      await trx
        .updateTable('colleges')
        .set({ reviewed_by: auth.userId, reviewed_at: sql`now()`, ...(decision === 'rejected' && { is_active: false }) })
        .where('id', '=', id)
        .execute();
      await this.record(trx, auth, `college.${decision}`, 'college', id, { pending: true }, { decision });
      return this.collegeView(trx, auth, id);
    });
  }

  // ---------------------------------------------------------------- helpers

  /** The delivery mode to filter by: the one asked for, else the lead's own study mode, else none. */
  private async effectiveMode(trx: Trx, auth: AuthContext, q: ListCollegesDto): Promise<'online' | 'regular' | 'any'> {
    if (q.mode) return q.mode;
    if (!q.leadId) return 'any';
    const lead = await this.access.get(trx, auth, q.leadId);
    return lead.study_mode === 'online' || lead.study_mode === 'regular' ? lead.study_mode : 'any';
  }

  private async offered(trx: Trx, collegeId: string, mode: 'online' | 'regular' | 'any', includeInactive: boolean): Promise<OfferedCourse[]> {
    const delivered = mode === 'online' ? sql`cc.delivery_mode IN ('online', 'both')` : mode === 'regular' ? sql`cc.delivery_mode IN ('regular', 'both')` : sql`true`;
    const { rows } = await sql<{
      id: string; delivery_mode: string; caf_fee: number | null; annual_fee: number | null; duration_years: number | null; is_active: boolean;
      course_id: string; course_name: string; level: string; stream: string | null;
    }>`
      SELECT cc.id, cc.delivery_mode, cc.caf_fee::float8 AS caf_fee, cc.annual_fee::float8 AS annual_fee, cc.duration_years::float8 AS duration_years,
             cc.is_active, c.id AS course_id, c.name AS course_name, c.level, s.name AS stream
      FROM college_courses cc JOIN courses c ON c.id = cc.course_id LEFT JOIN streams s ON s.id = c.stream_id
      WHERE cc.college_id = ${collegeId} AND ${delivered} ${includeInactive ? sql`` : sql`AND cc.is_active`}
      ORDER BY c.name`.execute(trx);
    return rows.map((r) => ({
      id: r.id, course: { id: r.course_id, name: r.course_name, level: r.level, stream: r.stream }, deliveryMode: r.delivery_mode,
      cafFee: r.caf_fee, annualFee: r.annual_fee, durationYears: r.duration_years, isActive: r.is_active,
    }));
  }

  private async upsertOffered(
    trx: Trx, tenantId: string, collegeId: string, courseId: string,
    d: { deliveryMode: string; cafFee: number | null; annualFee: number | null; durationYears: number | null; isActive?: boolean },
  ): Promise<void> {
    await trx
      .insertInto('college_courses')
      .values({
        tenant_id: tenantId, college_id: collegeId, course_id: courseId, delivery_mode: d.deliveryMode, caf_fee: d.cafFee,
        annual_fee: d.annualFee, duration_years: d.durationYears, is_active: d.isActive ?? true,
      })
      .onConflict((oc) => oc.columns(['college_id', 'course_id']).doUpdateSet({
        delivery_mode: d.deliveryMode, caf_fee: d.cafFee, annual_fee: d.annualFee, duration_years: d.durationYears, is_active: d.isActive ?? true,
      }))
      .execute();
  }

  /** The course with this name if the company has it, otherwise a new one. */
  private async courseForNewName(trx: Trx, auth: AuthContext, c: CreateCourseDto): Promise<string> {
    const existing = await trx.selectFrom('courses').select('id').where(sql`lower(name)`, '=', c.name.toLowerCase()).executeTakeFirst();
    return existing?.id ?? (await this.insertCourse(trx, auth, c));
  }

  private async insertCourse(trx: Trx, auth: AuthContext, dto: CreateCourseDto): Promise<string> {
    await this.assertCourseNameFree(trx, dto.name);
    if (dto.streamId) await this.assertStream(trx, dto.streamId);
    const row = await trx.insertInto('courses').values({ tenant_id: auth.tenantId, name: dto.name, level: dto.level, stream_id: dto.streamId ?? null }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  private async course(trx: Trx, id: string): Promise<CourseView> {
    const { rows } = await sql<CourseRow>`
      SELECT c.id, c.name, c.level, c.is_active, s.id AS stream_id, s.name AS stream_name, lower(c.name) AS sort_name
      FROM courses c LEFT JOIN streams s ON s.id = c.stream_id WHERE c.id = ${id}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Course');
    return toCourse(rows[0]);
  }

  private async requireCollege(trx: Trx, id: string): Promise<void> {
    if (!(await trx.selectFrom('colleges').select('id').where('id', '=', id).executeTakeFirst())) throw AppError.notFound('College');
  }

  private async assertLocation(trx: Trx, id: string | null | undefined): Promise<void> {
    if (!id) return;
    if (!(await trx.selectFrom('locations').select('id').where('id', '=', id).executeTakeFirst())) {
      throw AppError.badRequest('REFERENCE_INVALID', 'Choose a state or city from the list', [{ field: 'locationId', message: 'Choose one from the list' }]);
    }
  }

  private async assertStream(trx: Trx, id: string): Promise<void> {
    if (!(await trx.selectFrom('streams').select('id').where('id', '=', id).executeTakeFirst())) {
      throw AppError.badRequest('REFERENCE_INVALID', 'Choose a stream from the list', [{ field: 'streamId', message: 'Choose one from the list' }]);
    }
  }

  private async assertCourseNameFree(trx: Trx, name: string): Promise<void> {
    if (await trx.selectFrom('courses').select('id').where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst()) {
      throw AppError.conflict('COURSE_EXISTS', 'A course with this name already exists');
    }
  }

  /** The same institute in the same place is not added twice (a missing place counts as a place). */
  private async assertCollegeFree(trx: Trx, name: string, locationId: string | null, exceptId?: string): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM colleges
      WHERE lower(name) = ${name.toLowerCase()} AND location_id IS NOT DISTINCT FROM ${locationId}::uuid
        ${exceptId ? sql`AND id <> ${exceptId}::uuid` : sql``} LIMIT 1`.execute(trx);
    if (rows[0]) throw AppError.conflict('COLLEGE_EXISTS', 'This institute is already in the list', { existingId: rows[0].id });
  }

  private record(trx: Trx, auth: AuthContext, action: string, entity: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action, entity, entityId: id, before, after, ip: auth.ip, requestId: auth.requestId });
  }
}

// ---------------------------------------------------------------- mapping

export interface CourseView {
  id: string;
  name: string;
  level: string;
  stream: { id: string; name: string } | null;
  isActive: boolean;
}

interface CourseRow {
  id: string; name: string; level: string; is_active: boolean; stream_id: string | null; stream_name: string | null; sort_name: string;
}

const toCourse = (r: CourseRow): CourseView => ({
  id: r.id, name: r.name, level: r.level, isActive: r.is_active, stream: r.stream_id ? { id: r.stream_id, name: r.stream_name! } : null,
});
