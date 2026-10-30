import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { CSV_BOM, csvRow } from '../common/csv.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { displayName } from '../documents/file-rules.js';
import { AssignChoice, LeadIngestService } from '../intake/lead-ingest.service.js';
import { Assignees } from '../leads/assignees.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { applyOverride, detectMapping, Field, InvalidRow, Mapping, repeatsInFile, toRecords, validateRecords, ValidRow } from './import-rules.js';
import { readTable } from './spreadsheet.js';

/** Rows handled in one transaction. Small enough that a lock is held briefly, large enough to be quick. */
const CHUNK = 25;
/** How many problem rows are kept on a batch. The count of all of them is always kept. */
const MAX_STORED_ERRORS = 1000;

export type AssignInput = { mode: 'auto' | 'none' } | { mode: 'user'; userId: string };

export interface ImportInput {
  filename: string;
  data: Buffer;
  /** Column names chosen by the person, where the automatic match is wrong or missing. */
  mapping?: Partial<Record<Field, string>>;
}

export interface PreviewView {
  fileName: string;
  columns: string[];
  mapping: Partial<Record<Field, string>>;
  unmappedColumns: string[];
  /** Fields that must be mapped before importing. */
  missing: Field[];
  totals: { rows: number; valid: number; invalid: number; repeatedInFile: number; alreadyInCrm: number };
  sample: { row: number; name: string; phone: string }[];
  problems: InvalidRow[];
  problemsShown: number;
}

export interface BatchView {
  id: string;
  fileName: string;
  status: 'queued' | 'processing' | 'done' | 'cancelled';
  source: { id: string; name: string };
  assign: { mode: 'auto' | 'none' | 'user'; user: { id: string; name: string } | null };
  totals: { rows: number; invalid: number; toFile: number; processed: number; created: number; attached: number; rejected: number; failed: number };
  assigned: Record<string, number>;
  createdBy: { id: string; name: string };
  createdAt: Date;
  finishedAt: Date | null;
}

interface BatchRow {
  id: string; file_name: string; status: BatchView['status']; source_id: string; source_name: string; assign_mode: 'auto' | 'none' | 'user';
  assign_to: string | null; assignee_name: string | null; rows_in_file: number; invalid_count: number; next_row: number; created_count: number;
  attached_count: number; rejected_count: number; failed_count: number; assigned: Record<string, number>; created_by: string; creator_name: string;
  created_at: Date; finished_at: Date | null;
}

const missingFields = (mapping: Mapping): Field[] => (['name', 'phone'] as const).filter((f) => mapping[f] === undefined);

@Injectable()
export class ImportsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportsService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  /** Batches being worked on by this process, so a second kick-off does not start a second loop. */
  private readonly running = new Set<string>();

  constructor(
    private readonly db: DatabaseService,
    private readonly ingest: LeadIngestService,
    private readonly assignees: Assignees,
    private readonly notifications: NotificationsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.IMPORT_INTERVAL_SEC <= 0) return;
    this.timer = setInterval(() => void this.sweepSafely(), this.env.IMPORT_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------- preview

  /** Reads the file and reports what an import would do, without saving anything. */
  async preview(auth: AuthContext, input: ImportInput): Promise<PreviewView> {
    const table = await readTable(input.data);
    const mapping = applyOverride(table.header, detectMapping(table.header).mapping, input.mapping);
    const records = toRecords(table, mapping);
    const { valid, invalid } = validateRecords(records, 'import');

    const existing = await this.db.withTenant(auth.tenantId, (trx) => this.existingPhones(trx, valid.map((v) => v.lead.phone)));
    const shown = invalid.slice(0, 50);
    return {
      fileName: displayName(input.filename, input.filename.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv'),
      columns: table.header,
      mapping: Object.fromEntries(Object.entries(mapping).map(([f, at]) => [f, table.header[at]!])) as Partial<Record<Field, string>>,
      unmappedColumns: table.header.filter((_h, i) => !Object.values(mapping).includes(i) && table.header[i] !== ''),
      missing: missingFields(mapping),
      totals: { rows: records.length, valid: valid.length, invalid: invalid.length, repeatedInFile: repeatsInFile(valid), alreadyInCrm: existing.size },
      sample: valid.slice(0, 5).map((v) => ({ row: v.row, name: v.lead.name, phone: v.lead.phone })),
      problems: shown,
      problemsShown: shown.length,
    };
  }

  // ----------------------------------------------------------------- create

  /** Checks the file and queues it. The leads are filed in the background, a few at a time. */
  async create(auth: AuthContext, input: ImportInput & { sourceId: string; assign: AssignInput }): Promise<BatchView> {
    const table = await readTable(input.data);
    const mapping = applyOverride(table.header, detectMapping(table.header).mapping, input.mapping);
    const missing = missingFields(mapping);
    if (missing.length > 0) {
      throw new AppError('MAPPING_INCOMPLETE', `Say which column holds: ${missing.join(', ')}`, 422, undefined, undefined, { missing, columns: table.header });
    }
    const records = toRecords(table, mapping);
    if (records.length === 0) throw AppError.badRequest('EMPTY_SHEET', 'The file has a header but no leads');

    const source = await this.db.withTenant(auth.tenantId, (trx) =>
      trx.selectFrom('lead_sources').select(['id', 'name', 'is_active']).where('id', '=', input.sourceId).executeTakeFirst(),
    );
    if (!source?.is_active) {
      throw AppError.badRequest('SOURCE_INVALID', 'Choose an active lead source', [{ field: 'sourceId', message: 'Choose an active lead source' }]);
    }

    const fileName = displayName(input.filename, input.filename.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv');
    const { valid, invalid } = validateRecords(records, `import: ${fileName}`);
    if (valid.length === 0) throw new AppError('NOTHING_TO_IMPORT', 'None of the rows can be imported', 422, undefined, undefined, { problems: invalid.slice(0, 50) });

    const id = await this.db.withTenant(auth.tenantId, async (trx) => {
      if (input.assign.mode === 'user') await this.assignees.ensure(trx, auth, input.assign.userId);
      const row = await trx
        .insertInto('lead_import_batches')
        .values({
          tenant_id: auth.tenantId, source_id: source.id, file_name: fileName, assign_mode: input.assign.mode,
          assign_to: input.assign.mode === 'user' ? input.assign.userId : null, rows_in_file: records.length, invalid_count: invalid.length,
          rows: JSON.stringify(valid), errors: JSON.stringify(invalid.slice(0, MAX_STORED_ERRORS)), created_by: auth.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });

    this.kick(auth.tenantId, id);
    return this.get(auth, id);
  }

  // ------------------------------------------------------------------ reads

  list(auth: AuthContext): Promise<BatchView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'b.created_by');
      const { rows } = await sql<BatchRow>`${this.select()} ${scoped ? sql`WHERE ${scoped}` : sql``} ORDER BY b.created_at DESC, b.id DESC LIMIT 50`.execute(trx);
      return rows.map(toView);
    });
  }

  get(auth: AuthContext, id: string): Promise<BatchView> {
    return this.db.withTenant(auth.tenantId, async (trx) => toView(await this.one(trx, auth, id)));
  }

  /** The rows that were left out, as a CSV that can be corrected and imported again. */
  async errorReport(auth: AuthContext, id: string): Promise<{ fileName: string; csv: string }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const batch = await this.one(trx, auth, id);
      const { rows } = await sql<{ errors: (InvalidRow & { row: number })[] }>`SELECT errors FROM lead_import_batches WHERE id = ${id}`.execute(trx);
      const lines = rows[0]!.errors.map((e) => csvRow([e.row, e.name ?? '', e.phone ?? '', e.problem]));
      return { fileName: `${batch.file_name.replace(/\.[^.]+$/, '')}-problems.csv`, csv: CSV_BOM + csvRow(['Row', 'Name', 'Phone', 'Problem']) + lines.join('') };
    });
  }

  private select() {
    return sql`
      SELECT b.id, b.file_name, b.status, b.source_id, s.name AS source_name, b.assign_mode, b.assign_to, a.name AS assignee_name,
             b.rows_in_file, b.invalid_count, b.next_row, b.created_count, b.attached_count, b.rejected_count, b.failed_count,
             b.assigned, b.created_by, c.name AS creator_name, b.created_at, b.finished_at
      FROM lead_import_batches b
      JOIN lead_sources s ON s.id = b.source_id
      JOIN users c ON c.id = b.created_by
      LEFT JOIN users a ON a.id = b.assign_to`;
  }

  private async one(trx: Trx, auth: AuthContext, id: string): Promise<BatchRow> {
    const scoped = scopeCondition(auth, 'b.created_by');
    const { rows } = await sql<BatchRow>`${this.select()} WHERE b.id = ${id} ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Import');
    return rows[0];
  }

  private async existingPhones(trx: Trx, phones: string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();
    const { rows } = await sql<{ phone: string }>`
      SELECT primary_phone AS phone FROM leads WHERE deleted_at IS NULL AND primary_phone = ANY(${phones})
      UNION SELECT x.phone FROM lead_phones x JOIN leads l ON l.id = x.lead_id AND l.deleted_at IS NULL WHERE x.phone = ANY(${phones})`.execute(trx);
    return new Set(rows.map((r) => r.phone));
  }

  // ------------------------------------------------------------- processing

  /** Starts working on a batch right away, without making the caller wait for it. */
  private kick(tenantId: string, batchId: string): void {
    setImmediate(() => {
      this.process(tenantId, batchId).catch((err) => this.logger.error(`import ${batchId} stopped: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  /** Files the rows of one batch, chunk by chunk, until it is done. Safe to call from several places at once. */
  async process(tenantId: string, batchId: string): Promise<void> {
    if (this.running.has(batchId)) return;
    this.running.add(batchId);
    try {
      while (await this.processChunk(tenantId, batchId)) {
        // keep going until a chunk reports that there is nothing left or the batch is held by someone else
      }
    } finally {
      this.running.delete(batchId);
    }
  }

  /** Returns false when the batch is finished, cancelled, or being worked on elsewhere. */
  private processChunk(tenantId: string, batchId: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (trx) => {
      const { rows: locked } = await sql<{
        status: string; source_id: string; assign_mode: 'auto' | 'none' | 'user'; assign_to: string | null; next_row: number; file_name: string; created_by: string;
        total: number; assigned: Record<string, number>; errors: unknown[]; cnt: [number, number, number, number];
      }>`
        SELECT status, source_id, assign_mode, assign_to, next_row, file_name, created_by, jsonb_array_length(rows) AS total, assigned, errors,
               ARRAY[created_count, attached_count, rejected_count, failed_count] AS cnt
        FROM lead_import_batches WHERE id = ${batchId} AND status IN ('queued', 'processing') FOR UPDATE SKIP LOCKED`.execute(trx);
      const b = locked[0];
      if (!b) return false;

      const { rows: chunk } = await sql<{ elem: ValidRow }>`
        SELECT t.elem FROM lead_import_batches, jsonb_array_elements(rows) WITH ORDINALITY AS t(elem, ord)
        WHERE id = ${batchId} AND t.ord > ${b.next_row} AND t.ord <= ${b.next_row + CHUNK} ORDER BY t.ord`.execute(trx);

      const choice: AssignChoice = b.assign_mode === 'user' ? { mode: 'user', userId: b.assign_to! } : { mode: b.assign_mode };
      const [created, attached, rejected, failed] = b.cnt;
      const counts = { created, attached, rejected, failed };
      const assigned = { ...b.assigned };
      const errors = [...b.errors];

      for (const { elem } of chunk) {
        await sql`SAVEPOINT import_row`.execute(trx);
        try {
          const res = await this.ingest.ingest(trx, { tenantId, sourceId: b.source_id, eventId: null, lead: elem.lead, options: { assign: choice, quiet: true } });
          await sql`RELEASE SAVEPOINT import_row`.execute(trx);
          counts[res.outcome === 'created' ? 'created' : res.outcome === 'attached' ? 'attached' : 'rejected']++;
          if (res.outcome === 'created') {
            const key = res.assignedTo ?? 'unassigned';
            assigned[key] = (assigned[key] ?? 0) + 1;
          }
        } catch (err) {
          await sql`ROLLBACK TO SAVEPOINT import_row`.execute(trx);
          counts.failed++;
          this.logger.warn(`import ${batchId} row ${elem.row}: ${err instanceof Error ? err.message : String(err)}`);
          if (errors.length < MAX_STORED_ERRORS) errors.push({ row: elem.row, name: elem.lead.name, phone: elem.lead.phone, problem: 'Could not be saved. Try this row again.' });
        }
      }

      const next = b.next_row + chunk.length;
      const finished = next >= b.total;
      await sql`
        UPDATE lead_import_batches SET
          next_row = ${next}, created_count = ${counts.created}, attached_count = ${counts.attached}, rejected_count = ${counts.rejected},
          failed_count = ${counts.failed}, assigned = ${JSON.stringify(assigned)}::jsonb, errors = ${JSON.stringify(errors)}::jsonb,
          status = ${finished ? 'done' : 'processing'}, started_at = coalesce(started_at, now()),
          finished_at = ${finished ? sql`now()` : sql`NULL`}, rows = ${finished ? sql`'[]'::jsonb` : sql`rows`}
        WHERE id = ${batchId}`.execute(trx);

      if (finished) await this.announce(trx, tenantId, batchId, b.file_name, b.created_by, counts, assigned);
      return !finished && chunk.length > 0;
    });
  }

  /** One summary instead of a notification per lead. */
  private async announce(
    trx: Trx, tenantId: string, batchId: string, fileName: string, createdBy: string,
    counts: { created: number; attached: number; rejected: number; failed: number }, assigned: Record<string, number>,
  ): Promise<void> {
    await this.notifications.notify(trx, {
      tenantId, userIds: [createdBy], type: 'system',
      payload: { event: 'import_finished', batchId, fileName, ...counts, unassigned: assigned.unassigned ?? 0 },
    });
    for (const [userId, count] of Object.entries(assigned)) {
      if (userId === 'unassigned' || userId === createdBy) continue;
      await this.notifications.notify(trx, { tenantId, userIds: [userId], type: 'assignment', payload: { event: 'leads_imported', batchId, fileName, count } });
    }
  }

  // ---------------------------------------------------------------- restart

  private async sweepSafely(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { rows: tenants } = await sql<{ id: string }>`SELECT list_active_tenant_ids() AS id`.execute(this.db.unscoped());
      for (const { id: tenantId } of tenants) {
        const batches = await this.db.withTenant(tenantId, async (trx) => {
          const { rows } = await sql<{ id: string }>`SELECT id FROM lead_import_batches WHERE status IN ('queued', 'processing') ORDER BY created_at LIMIT 10`.execute(trx);
          return rows;
        });
        for (const { id } of batches) await this.process(tenantId, id);
      }
    } catch (err) {
      this.logger.error(`import sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }
}

function toView(r: BatchRow): BatchView {
  const toFile = r.rows_in_file - r.invalid_count;
  return {
    id: r.id, fileName: r.file_name, status: r.status, source: { id: r.source_id, name: r.source_name },
    assign: { mode: r.assign_mode, user: r.assign_to ? { id: r.assign_to, name: r.assignee_name ?? '' } : null },
    totals: { rows: r.rows_in_file, invalid: r.invalid_count, toFile, processed: r.next_row, created: r.created_count, attached: r.attached_count, rejected: r.rejected_count, failed: r.failed_count },
    assigned: r.assigned, createdBy: { id: r.created_by, name: r.creator_name }, createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

