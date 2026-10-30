import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { LeadAccess } from '../leads/lead-access.js';
import { LeadWriter } from '../leads/lead-writer.js';
import { FileLinks } from '../storage/file-links.service.js';
import { StorageService } from '../storage/storage.service.js';
import { tooLarge } from '../storage/multipart.js';
import { assertDocumentRules, displayName, DocType, pdfProblem, sniffFile } from './file-rules.js';

/** How many files of one kind a student can have, and in all. Stops a runaway upload loop. */
const MAX_PER_KIND = 10;
const MAX_PER_LEAD = 40;

export interface DocumentView {
  id: string;
  docType: string;
  shortlist: { id: string; college: string } | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: Date;
}

interface Row {
  id: string; doc_type: string; shortlist_id: string | null; college: string | null; original_name: string; mime_type: string;
  size_bytes: number; uploaded_by: string | null; created_at: Date; file_key: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly access: LeadAccess,
    private readonly writer: LeadWriter,
    private readonly storage: StorageService,
    private readonly links: FileLinks,
    @Inject(ENV) private readonly env: Env,
  ) {}

  list(auth: AuthContext, leadId: string): Promise<DocumentView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      return (await this.rows(trx, leadId)).map(toView);
    });
  }

  /**
   * Stores one uploaded file. What the file is comes from its bytes, never from its name or the type
   * the browser claimed. The file is written first and the record second; if the record cannot be
   * saved, the file is removed again, so nothing is left behind.
   */
  async upload(
    auth: AuthContext,
    leadId: string,
    input: { filename: string; data: Buffer; docType: DocType; shortlistId?: string },
  ): Promise<DocumentView> {
    if (input.data.length === 0) throw AppError.badRequest('EMPTY_FILE', 'The file is empty');
    if (input.data.length > this.env.MAX_UPLOAD_BYTES) throw tooLarge(this.env.MAX_UPLOAD_BYTES);

    const kind = sniffFile(input.data);
    if (!kind) throw new AppError('UNSUPPORTED_FILE', 'Only JPG, PNG and PDF files are accepted', 415);
    if (kind.type === 'pdf') {
      const problem = pdfProblem(input.data);
      if (problem) throw new AppError('UNSAFE_FILE', `${problem}, so it cannot be accepted`, 415);
    }

    let written: string | undefined;
    try {
      return await this.db.withTenant(auth.tenantId, async (trx) => {
        const lead = await this.access.get(trx, auth, leadId, true);
        if (input.shortlistId) await this.requireShortlist(trx, lead.id, input.shortlistId);
        assertDocumentRules({ docType: input.docType, hasShortlist: !!input.shortlistId, kind });
        await this.assertRoom(trx, lead.id, input.docType, input.shortlistId);

        const key = `${auth.tenantId}/${lead.id}/${randomUUID()}.${kind.ext}`;
        await this.storage.put(key, input.data);
        written = key;

        const name = displayName(input.filename, kind.ext);
        const row = await trx
          .insertInto('lead_documents')
          .values({
            tenant_id: auth.tenantId, lead_id: lead.id, shortlist_id: input.shortlistId ?? null, doc_type: input.docType, file_key: key,
            mime_type: kind.mime, size_bytes: input.data.length, uploaded_by: auth.userId, original_name: name,
            sha256: createHash('sha256').update(input.data).digest('hex'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.writer.activity(trx, { tenantId: auth.tenantId, leadId: lead.id, userId: auth.userId, type: 'document', field: input.docType, newValue: name, remark: 'Uploaded' });
        return toView(await this.one(trx, lead.id, row.id));
      });
    } catch (err) {
      if (written) await this.storage.delete(written).catch((e: unknown) => this.logger.error(`could not remove ${written}: ${String(e)}`));
      throw err;
    }
  }

  /** The file itself, for a person who is signed in and may see the lead. */
  async open(auth: AuthContext, leadId: string, docId: string) {
    const doc = await this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      return this.one(trx, leadId, docId);
    });
    const file = await this.storage.get(doc.file_key);
    if (!file) throw AppError.notFound('File');
    return { ...file, type: doc.mime_type, name: doc.original_name };
  }

  /** A link that opens the file without a login header, for a few minutes. */
  link(auth: AuthContext, leadId: string, docId: string) {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.access.get(trx, auth, leadId);
      const doc = await this.one(trx, leadId, docId);
      const { token, expiresAt } = this.links.sign({ key: doc.file_key, type: doc.mime_type, name: doc.original_name });
      return { url: `/api/v1/files/${token}`, expiresAt };
    });
  }

  async remove(auth: AuthContext, leadId: string, docId: string): Promise<void> {
    const key = await this.db.withTenant(auth.tenantId, async (trx) => {
      const lead = await this.access.get(trx, auth, leadId, true);
      const doc = await this.one(trx, lead.id, docId);
      await trx.deleteFrom('lead_documents').where('id', '=', docId).execute();
      await this.writer.activity(trx, { tenantId: auth.tenantId, leadId: lead.id, userId: auth.userId, type: 'document', field: doc.doc_type, oldValue: doc.original_name, remark: 'Removed' });
      return doc.file_key;
    });
    // After the record is gone for good. A file that cannot be removed now is only clutter.
    await this.storage.delete(key).catch((e: unknown) => this.logger.error(`could not remove ${key}: ${String(e)}`));
  }

  // ---------------------------------------------------------------- helpers

  private async rows(trx: Trx, leadId: string, docId?: string): Promise<Row[]> {
    const { rows } = await sql<Row>`
      SELECT d.id, d.doc_type, d.shortlist_id, c.name AS college, d.original_name, d.mime_type, d.size_bytes, u.name AS uploaded_by,
             d.created_at, d.file_key
      FROM lead_documents d
      LEFT JOIN lead_shortlists s ON s.id = d.shortlist_id
      LEFT JOIN colleges c ON c.id = s.college_id
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.lead_id = ${leadId} ${docId ? sql`AND d.id = ${docId}` : sql``}
      ORDER BY d.created_at DESC`.execute(trx);
    return rows;
  }

  private async one(trx: Trx, leadId: string, docId: string): Promise<Row> {
    const row = (await this.rows(trx, leadId, docId))[0];
    if (!row) throw AppError.notFound('Document');
    return row;
  }

  private async requireShortlist(trx: Trx, leadId: string, shortlistId: string): Promise<void> {
    const found = await trx.selectFrom('lead_shortlists').select('id').where('id', '=', shortlistId).where('lead_id', '=', leadId).executeTakeFirst();
    if (!found) throw AppError.badRequest('SHORTLIST_INVALID', 'That institute is not on this student\'s shortlist', [{ field: 'shortlistId', message: 'Choose a shortlisted institute' }]);
  }

  private async assertRoom(trx: Trx, leadId: string, docType: string, shortlistId: string | undefined): Promise<void> {
    const { rows } = await sql<{ total: string; same: string }>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE doc_type = ${docType} AND shortlist_id IS NOT DISTINCT FROM ${shortlistId ?? null}::uuid) AS same
      FROM lead_documents WHERE lead_id = ${leadId}`.execute(trx);
    if (Number(rows[0]!.same) >= MAX_PER_KIND) throw AppError.conflict('TOO_MANY_FILES', `A student can have at most ${MAX_PER_KIND} files of one kind. Remove one first.`);
    if (Number(rows[0]!.total) >= MAX_PER_LEAD) throw AppError.conflict('TOO_MANY_FILES', `A student can have at most ${MAX_PER_LEAD} files. Remove one first.`);
  }
}

function toView(r: Row): DocumentView {
  return {
    id: r.id, docType: r.doc_type, shortlist: r.shortlist_id ? { id: r.shortlist_id, college: r.college ?? '' } : null,
    name: r.original_name, mimeType: r.mime_type, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, createdAt: r.created_at,
  };
}
