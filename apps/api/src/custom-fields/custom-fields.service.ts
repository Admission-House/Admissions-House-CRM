import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { checkValue, DataType, FieldDef } from './custom-field-rules.js';

const option = z.object({ value: z.string().trim().regex(/^[\w .-]{1,60}$/, 'Letters, numbers, spaces, dots, dashes and underscores'), label: z.string().trim().min(1).max(80) });

export const createFieldSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Start with a lower-case letter; use lower-case letters, numbers and underscores'),
    label: z.string().trim().min(2).max(80),
    dataType: z.enum(['text', 'number', 'date', 'select']),
    isRequired: z.boolean().default(false),
    options: z.array(option).max(50).default([]),
  })
  .refine((v) => (v.dataType === 'select') === v.options.length > 0, { path: ['options'], message: 'A dropdown needs options, and other types must not have any' })
  .refine((v) => new Set(v.options.map((o) => o.value)).size === v.options.length, { path: ['options'], message: 'Each option value must be different' });
export type CreateField = z.infer<typeof createFieldSchema>;

export const updateFieldSchema = z
  .object({ label: z.string().trim().min(2).max(80), isRequired: z.boolean(), isActive: z.boolean(), sortOrder: z.number().int().min(0).max(10_000), options: z.array(option).max(50) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export type UpdateField = z.infer<typeof updateFieldSchema>;

export interface FieldView extends FieldDef {
  id: string;
  isActive: boolean;
  sortOrder: number;
}

interface DefRow {
  id: string; key: string; label: string; data_type: DataType; is_required: boolean; is_active: boolean; sort_order: number;
  options: { value: string; label: string }[] | null;
}

const DEFS = sql`
  SELECT d.id, d.key, d.label, d.data_type, d.is_required, d.is_active, d.sort_order,
         (SELECT jsonb_agg(jsonb_build_object('value', o.value, 'label', o.label) ORDER BY o.sort_order, o.value) FROM custom_field_options o WHERE o.def_id = d.id) AS options
  FROM custom_field_defs d WHERE d.entity = 'lead'`;

/**
 * Extra fields a company wants on its leads. The Super Admin defines them; counsellors fill them in.
 * A field's key and type never change once made (stored values depend on them); it can be switched
 * off, which hides it but keeps what was entered. A required field cannot be cleared, but leads
 * created before the field existed are not blocked from other changes.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
  ) {}

  list(auth: AuthContext, includeInactive: boolean): Promise<FieldView[]> {
    return this.db.withTenant(auth.tenantId, (trx) => this.defs(trx, includeInactive));
  }

  create(auth: AuthContext, dto: CreateField): Promise<FieldView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows: taken } = await sql<{ id: string }>`SELECT id FROM custom_field_defs WHERE entity = 'lead' AND key = ${dto.key}`.execute(trx);
      if (taken[0]) throw new AppError('FIELD_EXISTS', `A field with the key "${dto.key}" already exists`, 409, [{ field: 'key', message: 'Already used' }]);
      const { rows: next } = await sql<{ n: number }>`SELECT coalesce(max(sort_order), 0) + 10 AS n FROM custom_field_defs WHERE entity = 'lead'`.execute(trx);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO custom_field_defs (tenant_id, key, label, data_type, is_required, sort_order)
        VALUES (${auth.tenantId}, ${dto.key}, ${dto.label}, ${dto.dataType}, ${dto.isRequired}, ${next[0]!.n}) RETURNING id`.execute(trx);
      await this.setOptions(trx, auth.tenantId, rows[0]!.id, dto.options);
      await this.record(trx, auth, 'custom_field.create', rows[0]!.id, undefined, { key: dto.key, dataType: dto.dataType, required: dto.isRequired });
      return this.one(trx, rows[0]!.id);
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateField): Promise<FieldView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.one(trx, id);
      if (dto.options && before.dataType !== 'select') throw AppError.badRequest('OPTIONS_NOT_ALLOWED', 'Only a dropdown has options', [{ field: 'options', message: 'Not a dropdown' }]);
      if (dto.options) {
        if (dto.options.length === 0) throw AppError.badRequest('OPTIONS_REQUIRED', 'A dropdown needs at least one option', [{ field: 'options', message: 'Add an option' }]);
        if (new Set(dto.options.map((o) => o.value)).size !== dto.options.length) throw AppError.badRequest('OPTIONS_DUPLICATE', 'Each option value must be different', [{ field: 'options', message: 'Duplicate value' }]);
        const { rows: used } = await sql<{ value: string }>`
          SELECT DISTINCT v.value FROM custom_field_values v WHERE v.def_id = ${id}::uuid AND NOT (v.value = ANY(${dto.options.map((o) => o.value)}::text[]))`.execute(trx);
        if (used[0]) throw new AppError('OPTION_IN_USE', `The option "${used[0].value}" is used on leads and cannot be removed`, 409, [{ field: 'options', message: 'In use' }]);
        await this.setOptions(trx, auth.tenantId, id, dto.options);
      }
      const set = { ...(dto.label !== undefined && { label: dto.label }), ...(dto.isRequired !== undefined && { is_required: dto.isRequired }), ...(dto.isActive !== undefined && { is_active: dto.isActive }), ...(dto.sortOrder !== undefined && { sort_order: dto.sortOrder }) };
      if (Object.keys(set).length > 0) await trx.updateTable('custom_field_defs').set(set).where('id', '=', id).execute();
      await this.record(trx, auth, 'custom_field.update', id, { label: before.label, required: before.isRequired, active: before.isActive }, { ...dto, options: dto.options?.length });
      return this.one(trx, id);
    });
  }

  // ------------------------------------------------------------ on a lead

  /** The active fields with the lead's value for each. */
  forLead(auth: AuthContext, leadId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      return this.valuesOf(trx, leadId);
    });
  }

  /** Sets values by field key. A null clears a value. Only the keys sent are touched. */
  setForLead(auth: AuthContext, leadId: string, values: Record<string, unknown>) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      const defs = new Map((await this.defs(trx, false)).map((d) => [d.key, d]));
      const errors: { field: string; message: string }[] = [];
      const changes: { def: FieldView; value: string | null }[] = [];
      for (const [key, raw] of Object.entries(values)) {
        const def = defs.get(key);
        if (!def) {
          errors.push({ field: key, message: 'There is no such field' });
          continue;
        }
        const checked = checkValue(def, raw);
        if (checked.ok) changes.push({ def, value: checked.value });
        else errors.push({ field: key, message: checked.message });
      }
      if (errors.length > 0) throw AppError.badRequest('VALIDATION_FAILED', 'Some values are not valid', errors);

      for (const { def, value } of changes) {
        const { rows: old } = await sql<{ value: string }>`SELECT value FROM custom_field_values WHERE lead_id = ${lead.id}::uuid AND def_id = ${def.id}::uuid`.execute(trx);
        if ((old[0]?.value ?? null) === value) continue;
        if (value === null) await sql`DELETE FROM custom_field_values WHERE lead_id = ${lead.id}::uuid AND def_id = ${def.id}::uuid`.execute(trx);
        else {
          await sql`
            INSERT INTO custom_field_values (tenant_id, def_id, lead_id, value) VALUES (${auth.tenantId}, ${def.id}, ${lead.id}, ${value})
            ON CONFLICT (lead_id, def_id) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
        }
        await this.writer.activity(trx, { tenantId: auth.tenantId, leadId: lead.id, userId: auth.userId, type: 'field_change', field: def.label, oldValue: old[0]?.value ?? null, newValue: value });
      }
      if (changes.length > 0) await sql`UPDATE leads SET updated_at = now(), updated_by = ${auth.userId} WHERE id = ${lead.id}::uuid`.execute(trx);
      return this.valuesOf(trx, lead.id);
    });
  }

  // ----------------------------------------------------------------- inner

  private async valuesOf(trx: Trx, leadId: string) {
    const defs = await this.defs(trx, false);
    const { rows } = await sql<{ def_id: string; value: string }>`SELECT def_id, value FROM custom_field_values WHERE lead_id = ${leadId}::uuid`.execute(trx);
    const byDef = new Map(rows.map((r) => [r.def_id, r.value]));
    return defs.map((d) => ({ ...d, value: byDef.get(d.id) ?? null }));
  }

  private async defs(trx: Trx, includeInactive: boolean): Promise<FieldView[]> {
    const { rows } = await sql<DefRow>`${DEFS} ${includeInactive ? sql`` : sql`AND d.is_active`} ORDER BY d.sort_order, d.key`.execute(trx);
    return rows.map(toView);
  }

  private async one(trx: Trx, id: string): Promise<FieldView> {
    const { rows } = await sql<DefRow>`${DEFS} AND d.id = ${id}::uuid`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Custom field');
    return toView(rows[0]);
  }

  private async setOptions(trx: Trx, tenantId: string, defId: string, options: { value: string; label: string }[]) {
    await sql`DELETE FROM custom_field_options WHERE def_id = ${defId}::uuid`.execute(trx);
    for (const [i, o] of options.entries()) {
      await sql`INSERT INTO custom_field_options (tenant_id, def_id, value, label, sort_order) VALUES (${tenantId}, ${defId}, ${o.value}, ${o.label}, ${i})`.execute(trx);
    }
  }

  private record(trx: Trx, auth: AuthContext, action: string, id: string, before: unknown, after: unknown) {
    return this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action, entity: 'custom_field', entityId: id, before, after, ip: auth.ip, requestId: auth.requestId });
  }
}

function toView(r: DefRow): FieldView {
  return { id: r.id, key: r.key, label: r.label, dataType: r.data_type, isRequired: r.is_required, isActive: r.is_active, sortOrder: r.sort_order, options: r.options ?? [] };
}
