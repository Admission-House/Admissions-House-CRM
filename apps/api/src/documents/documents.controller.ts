import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { FileLinks } from '../storage/file-links.service.js';
import { StorageService } from '../storage/storage.service.js';
import { readForm } from '../storage/multipart.js';
import { DocumentsService } from './documents.service.js';
import { DOC_TYPES } from './file-rules.js';
import { sendFile } from './file-response.js';

const fieldsSchema = z.object({
  docType: z.enum(DOC_TYPES),
  /** For an admission document: the shortlisted institute it belongs to. */
  shortlistId: z.uuid().optional(),
});

@ApiTags('documents')
@ApiBearerAuth()
@Controller('leads/:id/documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @RequirePermissions('lead.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.list(auth, id);
  }

  /**
   * Upload one file as multipart/form-data: a `file` part, and the fields `docType` and, for an
   * admission document, `shortlistId`. JPG, PNG or PDF, up to the size limit.
   */
  @RequirePermissions('document.manage')
  @ApiConsumes('multipart/form-data')
  @Post()
  async upload(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: FastifyRequest) {
    const { fields, file } = await readForm(req, this.env.MAX_UPLOAD_BYTES);
    if (!file) throw AppError.badRequest('NO_FILE', 'No file was sent', [{ field: 'file', message: 'Attach the file' }]);

    const parsed = fieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    return this.documents.upload(auth, id, { ...file, ...parsed.data });
  }

  /** The file itself, for a signed-in client that can send its login header. */
  @RequirePermissions('lead.read')
  @Get(':docId/file')
  async file(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.documents.open(auth, id, docId);
    return sendFile(reply, f, f.type, f.name);
  }

  /** A link that opens the file in a browser tag, valid for a few minutes. */
  @RequirePermissions('lead.read')
  @Post(':docId/link')
  @HttpCode(200)
  link(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string) {
    return this.documents.link(auth, id, docId);
  }

  @RequirePermissions('document.manage')
  @Delete(':docId')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string): Promise<void> {
    return this.documents.remove(auth, id, docId);
  }
}

/** Opens a file from a signed link. The link is the credential, so this route has no login. */
@ApiTags('documents')
@Public()
@Controller('files')
export class FilesController {
  constructor(
    private readonly links: FileLinks,
    private readonly storage: StorageService,
  ) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const checked = this.links.verify(token);
    if (!checked.ok) {
      throw new AppError(checked.reason === 'expired' ? 'LINK_EXPIRED' : 'LINK_INVALID', checked.reason === 'expired' ? 'This link has expired. Ask for a new one.' : 'This link is not valid.', 403);
    }
    const file = await this.storage.get(checked.claims.key);
    if (!file) throw AppError.notFound('File');
    return sendFile(reply, file, checked.claims.type, checked.claims.name);
  }
}

/** What the upload screen needs to tell people before they choose a file. */
@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentLimitsController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @RequirePermissions('lead.read')
  @Get('limits')
  limits() {
    return { maxBytes: this.env.MAX_UPLOAD_BYTES, accepts: ['jpg', 'jpeg', 'png', 'pdf'], imageOnly: ['photo', 'signature'] };
  }
}
