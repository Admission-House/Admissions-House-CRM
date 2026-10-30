import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { applyColumnOverride } from '../imports/import-rules.js';
import { readTable, type Table } from '../imports/spreadsheet.js';
import { detectMasterMapping, FIELDS, MasterField, MasterProblem, MasterRow, parseMasterRows } from './master-import-rules.js';

export interface MasterImportResult {
  rows: number;
  /** What the file adds or changes. For a preview nothing has been saved yet. */
  colleges: { new: number; existing: number };
  courses: { new: number; existing: number };
  offers: { new: number; updated: number };
  problems: MasterProblem[];
  applied: boolean;
}

interface Plan {
  collegeKey: string;
  locationId: string | null;
  row: MasterRow;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Loads colleges, courses and their fees from a spreadsheet: one row for each course a college
 * offers. A preview tells what would change; the import then does it in one transaction, so a failure
 * leaves the lists as they were. Rows that cannot be understood are reported, never guessed at: an
 * unknown city, an unknown stream or a course whose level disagrees with the list is a problem row.
 */
@Injectable()
export class MasterImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  preview(auth: AuthContext, input: { data: Buffer; mapping?: Partial<Record<MasterField, string>> }): Promise<MasterImportResult & { columns: string[]; missing: MasterField[] }> {
    return this.run(auth, input, false);
  }

  apply(auth: AuthContext, input: { data: Buffer; fileName: string; mapping?: Partial<Record<MasterField, string>> }): Promise<MasterImportResult> {
    return this.run(auth, input, true);
  }

  /** The same preview and import for rows that did not come from a file, such as the college data provider's API. */
  previewTable(auth: AuthContext, table: Table) {
    return this.run(auth, { table }, false);
  }

  applyTable(auth: AuthContext, table: Table, fileName: string) {
    return this.run(auth, { table, fileName }, true);
  }

  private async run(auth: AuthContext, input: { data?: Buffer; table?: Table; fileName?: string; mapping?: Partial<Record<MasterField, string>> }, apply: boolean) {
    const table = input.table ?? (await readTable(input.data!));
    const mapping = applyColumnOverride(table.header, detectMasterMapping(table.header), input.mapping, FIELDS);
    const missing = (['college', 'course', 'mode'] as const).filter((f) => mapping[f] === undefined);
    if (apply && missing.length > 0) {
      throw new AppError('MAPPING_INCOMPLETE', `Say which column holds: ${missing.join(', ')}`, 422, undefined, undefined, { missing, columns: table.header });
    }
    const parsed = parseMasterRows(table, mapping);

    const result = await this.db.withTenant(auth.tenantId, async (trx) => {
      const out: MasterImportResult = {
        rows: parsed.rows.length + parsed.problems.length, colleges: { new: 0, existing: 0 }, courses: { new: 0, existing: 0 },
        offers: { new: 0, updated: 0 }, problems: [...parsed.problems], applied: apply,
      };
      const plans = await this.resolve(trx, parsed.rows, out.problems);

      const collegeIds = new Map<string, string | null>(); // college key -> id, null when it does not exist yet
      const courseIds = new Map<string, string | null>();
      const seenOffers = new Set<string>();

      for (const plan of plans) {
        const { row } = plan;
        const courseKey = lower(row.course);

        let collegeId = collegeIds.get(plan.collegeKey);
        if (collegeId === undefined) {
          collegeId = await this.findCollege(trx, row.college, plan.locationId);
          collegeIds.set(plan.collegeKey, collegeId);
          out.colleges[collegeId ? 'existing' : 'new']++;
          if (!collegeId && apply) {
            collegeId = (
              await trx.insertInto('colleges').values({ tenant_id: auth.tenantId, name: row.college, location_id: plan.locationId, reviewed_by: auth.userId, reviewed_at: sql`now()` } as never)
                .returning('id').executeTakeFirstOrThrow()
            ).id;
            collegeIds.set(plan.collegeKey, collegeId);
          }
        }

        let courseId = courseIds.get(courseKey);
        if (courseId === undefined) {
          const found = await trx.selectFrom('courses').select(['id', 'level']).where(sql`lower(name)`, '=', courseKey).executeTakeFirst();
          if (found && row.level && found.level !== row.level) {
            out.problems.push({ row: row.row, college: row.college, course: row.course, problem: `level: ${row.course} is already in the list as ${found.level}` });
            continue;
          }
          if (!found && !row.level) {
            out.problems.push({ row: row.row, college: row.college, course: row.course, problem: 'level: New course, so say whether it is UG, PG or Diploma' });
            continue;
          }
          courseId = found?.id ?? null;
          if (!found) {
            const streamId = row.stream ? await this.findStream(trx, row.stream) : null;
            if (row.stream && !streamId) {
              out.problems.push({ row: row.row, college: row.college, course: row.course, problem: `stream: "${row.stream}" is not in the list of streams` });
              continue;
            }
            if (apply) {
              courseId = (await trx.insertInto('courses').values({ tenant_id: auth.tenantId, name: row.course, level: row.level!, stream_id: streamId }).returning('id').executeTakeFirstOrThrow()).id;
            }
          }
          courseIds.set(courseKey, courseId);
          out.courses[found ? 'existing' : 'new']++;
        }

        const offerKey = `${plan.collegeKey}|${courseKey}`;
        if (seenOffers.has(offerKey)) {
          out.problems.push({ row: row.row, college: row.college, course: row.course, problem: 'This college and course appear more than once in the file' });
          continue;
        }
        seenOffers.add(offerKey);

        const existing = collegeId && courseId
          ? await trx.selectFrom('college_courses').select('id').where('college_id', '=', collegeId).where('course_id', '=', courseId).executeTakeFirst()
          : undefined;
        out.offers[existing ? 'updated' : 'new']++;
        if (apply) {
          await sql`
            INSERT INTO college_courses (tenant_id, college_id, course_id, delivery_mode, caf_fee, annual_fee, duration_years)
            VALUES (${auth.tenantId}, ${collegeId}, ${courseId}, ${row.mode}, ${row.cafFee}, ${row.annualFee}, ${row.duration})
            ON CONFLICT (college_id, course_id) DO UPDATE SET
              delivery_mode = EXCLUDED.delivery_mode, caf_fee = EXCLUDED.caf_fee, annual_fee = EXCLUDED.annual_fee,
              duration_years = EXCLUDED.duration_years, is_active = true`.execute(trx);
        }
      }

      out.problems.sort((a, b) => a.row - b.row);
      if (apply) {
        await this.audit.write(trx, {
          tenantId: auth.tenantId, actorId: auth.userId, action: 'master.import', entity: 'college',
          after: { file: input.fileName, colleges: out.colleges, courses: out.courses, offers: out.offers, skipped: out.problems.length }, ip: auth.ip, requestId: auth.requestId,
        });
      }
      return out;
    });
    return { ...result, columns: table.header, missing };
  }

  /** Works out the city of each row. A city that is unknown, or that exists in several states, is a problem row. */
  private async resolve(trx: Trx, rows: MasterRow[], problems: MasterProblem[]): Promise<Plan[]> {
    const cache = new Map<string, string | null | 'ambiguous'>();
    const plans: Plan[] = [];
    for (const row of rows) {
      let locationId: string | null = null;
      if (row.city) {
        const k = `${lower(row.city)}|${lower(row.state ?? '')}`;
        if (!cache.has(k)) {
          const { rows: found } = await sql<{ id: string }>`
            SELECT c.id FROM locations c LEFT JOIN locations p ON p.id = c.parent_id
            WHERE c.type = 'city' AND lower(c.name) = ${lower(row.city)} ${row.state ? sql`AND lower(p.name) = ${lower(row.state)}` : sql``} LIMIT 2`.execute(trx);
          cache.set(k, found.length === 1 ? found[0]!.id : found.length === 0 ? null : 'ambiguous');
        }
        const hit = cache.get(k)!;
        if (hit === null) {
          problems.push({ row: row.row, college: row.college, course: row.course, problem: `city: "${row.city}"${row.state ? ` in ${row.state}` : ''} is not in the list of places` });
          continue;
        }
        if (hit === 'ambiguous') {
          problems.push({ row: row.row, college: row.college, course: row.course, problem: `city: "${row.city}" is in more than one state. Add a state column.` });
          continue;
        }
        locationId = hit;
      }
      plans.push({ collegeKey: `${lower(row.college)}|${locationId ?? ''}`, locationId, row });
    }
    return plans;
  }

  private async findCollege(trx: Trx, name: string, locationId: string | null): Promise<string | null> {
    const found = await trx
      .selectFrom('colleges').select('id').where(sql`lower(name)`, '=', lower(name))
      .where(locationId ? sql<SqlBool>`location_id = ${locationId}` : sql<SqlBool>`location_id IS NULL`)
      .executeTakeFirst();
    return found?.id ?? null;
  }

  private async findStream(trx: Trx, name: string): Promise<string | null> {
    const found = await trx.selectFrom('streams').select('id').where(sql`lower(name)`, '=', lower(name)).executeTakeFirst();
    return found?.id ?? null;
  }
}
