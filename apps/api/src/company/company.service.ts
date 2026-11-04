import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { sniffFile } from '../documents/file-rules.js';
import { StorageService } from '../storage/storage.service.js';
import { parseTwoStepPolicy, TWO_STEP_POLICIES, twoStepRequired, type TwoStepPolicy } from '../auth/two-step-policy.js';

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour such as #063b39');

export const companySchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    productName: z.string().trim().min(2).max(80),
    contactEmail: z.string().trim().toLowerCase().email().max(254).nullable(),
    brandColor: hex.nullable(),
    accentColor: hex.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change');
export type CompanyInput = z.infer<typeof companySchema>;

export const securitySchema = z.object({ requireTwoStep: z.enum(TWO_STEP_POLICIES) });

export interface CompanyView {
  name: string;
  productName: string;
  contactEmail: string | null;
  brandColor: string | null;
  accentColor: string | null;
  hasLogo: boolean;
}

interface Settings {
  product_name?: string;
  contact_email?: string | null;
  brand_color?: string | null;
  accent_color?: string | null;
  logo_key?: string | null;
  logo_mime?: string | null;
  require_two_step?: string;
}

/** A logo is small on purpose: it is loaded on every screen. */
export const MAX_LOGO_BYTES = 512 * 1024;

function view(c: { name: string; settings: Settings }): CompanyView {
  return {
    name: c.name,
    productName: c.settings.product_name ?? `${c.name} CRM`,
    contactEmail: c.settings.contact_email ?? null,
    brandColor: c.settings.brand_color ?? null,
    accentColor: c.settings.accent_color ?? null,
    hasLogo: !!c.settings.logo_key,
  };
}

/**
 * The company's own name, product name, contact address, colours and logo: what makes the CRM look
 * like theirs. Only people who manage settings change it, and every change is audited.
 */
@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  get(auth: AuthContext): Promise<CompanyView> {
    return this.db.withTenant(auth.tenantId, async (trx) => view(await this.load(trx)));
  }

  update(auth: AuthContext, input: CompanyInput): Promise<CompanyView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.load(trx);
      const s = { ...before.settings };
      if (input.productName !== undefined) s.product_name = input.productName;
      if (input.contactEmail !== undefined) s.contact_email = input.contactEmail;
      if (input.brandColor !== undefined) s.brand_color = input.brandColor?.toLowerCase() ?? null;
      if (input.accentColor !== undefined) s.accent_color = input.accentColor?.toLowerCase() ?? null;
      const name = input.name ?? before.name;
      await sql`UPDATE tenants SET name = ${name}, settings = ${JSON.stringify(s)}::jsonb WHERE id = ${auth.tenantId}`.execute(trx);
      const after = await this.load(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'company.update', entity: 'company', entityId: auth.tenantId,
        before: view(before), after: view(after), ip: auth.ip, requestId: auth.requestId,
      });
      return view(after);
    });
  }

  /** Who the company requires to use two-step sign-in. */
  getSecurity(auth: AuthContext): Promise<{ requireTwoStep: TwoStepPolicy }> {
    return this.db.withTenant(auth.tenantId, async (trx) => ({ requireTwoStep: parseTwoStepPolicy((await this.load(trx)).settings.require_two_step) }));
  }

  /** Changes who is required. People it now covers are asked to set it up on their next request. */
  setSecurity(auth: AuthContext, requireTwoStep: TwoStepPolicy): Promise<{ requireTwoStep: TwoStepPolicy }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      // A setting that covers you would hold you at once, in the middle of changing it. Set yours up first.
      if (twoStepRequired(requireTwoStep, auth.roleKey)) {
        const { rows } = await sql<{ one: number }>`SELECT 1 AS one FROM user_mfa WHERE user_id = ${auth.userId} AND enabled_at IS NOT NULL`.execute(trx);
        if (rows.length === 0) throw new AppError('SET_UP_YOUR_OWN_FIRST', 'This setting would cover you. Set up your own two-step sign-in first (My account), then change it.', 409);
      }
      const before = await this.load(trx);
      const was = parseTwoStepPolicy(before.settings.require_two_step);
      await sql`UPDATE tenants SET settings = ${JSON.stringify({ ...before.settings, require_two_step: requireTwoStep })}::jsonb WHERE id = ${auth.tenantId}`.execute(trx);
      if (was !== requireTwoStep) {
        await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'company.security_change', entity: 'company', entityId: auth.tenantId, before: { requireTwoStep: was }, after: { requireTwoStep }, ip: auth.ip, requestId: auth.requestId });
      }
      return { requireTwoStep };
    });
  }

  /** Replaces the logo. Only a real JPG or PNG is accepted, judged by its content and not its name. */
  async setLogo(auth: AuthContext, data: Buffer): Promise<CompanyView> {
    if (data.length === 0) throw AppError.badRequest('EMPTY_FILE', 'The file is empty');
    if (data.length > MAX_LOGO_BYTES) throw new AppError('FILE_TOO_LARGE', 'The logo must be 512 KB or smaller', 413);
    const kind = sniffFile(data);
    if (!kind || kind.type === 'pdf') throw new AppError('UNSUPPORTED_FILE', 'The logo must be a JPG or PNG picture', 415);

    const key = `${auth.tenantId}/brand/${randomUUID()}.${kind.ext}`;
    await this.storage.put(key, data);
    let oldKey: string | null | undefined;
    try {
      const result = await this.db.withTenant(auth.tenantId, async (trx) => {
        const before = await this.load(trx);
        oldKey = before.settings.logo_key;
        const s = { ...before.settings, logo_key: key, logo_mime: kind.mime };
        await sql`UPDATE tenants SET settings = ${JSON.stringify(s)}::jsonb WHERE id = ${auth.tenantId}`.execute(trx);
        await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'company.logo_change', entity: 'company', entityId: auth.tenantId, ip: auth.ip, requestId: auth.requestId });
        return view(await this.load(trx));
      });
      if (oldKey) await this.discard(oldKey);
      return result;
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  async removeLogo(auth: AuthContext): Promise<CompanyView> {
    let oldKey: string | null | undefined;
    const result = await this.db.withTenant(auth.tenantId, async (trx) => {
      const before = await this.load(trx);
      oldKey = before.settings.logo_key;
      const rest = { ...before.settings };
      delete rest.logo_key;
      delete rest.logo_mime;
      await sql`UPDATE tenants SET settings = ${JSON.stringify(rest)}::jsonb WHERE id = ${auth.tenantId}`.execute(trx);
      await this.audit.write(trx, { tenantId: auth.tenantId, actorId: auth.userId, action: 'company.logo_remove', entity: 'company', entityId: auth.tenantId, ip: auth.ip, requestId: auth.requestId });
      return view(await this.load(trx));
    });
    if (oldKey) await this.discard(oldKey);
    return result;
  }

  /** The logo for the signed-in company, or null when none was uploaded. */
  async logo(auth: AuthContext) {
    const s = (await this.db.withTenant(auth.tenantId, (trx) => this.load(trx))).settings;
    if (!s.logo_key) return null;
    const file = await this.storage.get(s.logo_key);
    return file ? { ...file, mime: s.logo_mime ?? 'image/png' } : null;
  }

  private async discard(key: string): Promise<void> {
    await this.storage.delete(key).catch((e: unknown) => this.logger.error(`could not remove ${key}: ${String(e)}`));
  }

  private async load(trx: Trx) {
    const row = await trx.selectFrom('tenants').select(['name', 'settings']).executeTakeFirstOrThrow();
    return { name: row.name, settings: (row.settings ?? {}) as Settings };
  }
}
