import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { readForm } from '../storage/multipart.js';
import { FIELDS } from './import-rules.js';
import { mappingField } from './mapping-field.js';
import { ImportsService } from './imports.service.js';

const mappingField_ = mappingField(FIELDS);
const previewFields = z.object({ mapping: mappingField_ });
const importFields = z
  .object({
    sourceId: z.uuid(),
    assign: z.enum(['auto', 'none', 'user']).default('auto'),
    userId: z.uuid().optional(),
    mapping: mappingField_,
  })
  .refine((v) => (v.assign === 'user') === !!v.userId, { path: ['userId'], message: 'Give userId when assigning to one person, and only then' });

@ApiTags('lead import')
@ApiBearerAuth()
@Controller('leads/import')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Reads a CSV or Excel file and says what importing it would do. Nothing is saved. */
  @RequirePermissions('lead.import')
  @ApiConsumes('multipart/form-data')
  @Post('preview')
  @HttpCode(200)
  async preview(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const { fields, file } = await this.read(req);
    const parsed = previewFields.safeParse(fields);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    return this.imports.preview(auth, { ...file, mapping: parsed.data.mapping });
  }

  /** Queues the file. The leads are filed in the background; follow the batch to see progress. */
  @RequirePermissions('lead.import')
  @ApiConsumes('multipart/form-data')
  @Post()
  async create(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { fields, file } = await this.read(req);
    const parsed = importFields.safeParse(fields);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    const { sourceId, assign, userId, mapping } = parsed.data;
    reply.status(202);
    return this.imports.create(auth, { ...file, mapping, sourceId, assign: assign === 'user' ? { mode: 'user', userId: userId! } : { mode: assign } });
  }

  @RequirePermissions('lead.import')
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.imports.list(auth);
  }

  @RequirePermissions('lead.import')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(auth, id);
  }

  /** The rows that were skipped and why, as a CSV. */
  @RequirePermissions('lead.import')
  @Get(':id/problems.csv')
  async problems(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const report = await this.imports.errorReport(auth, id);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${encodeURIComponent(report.fileName)}"`).header('cache-control', 'private, no-store');
    return report.csv;
  }

  private async read(req: FastifyRequest) {
    const { fields, file } = await readForm(req, this.env.MAX_UPLOAD_BYTES);
    if (!file) throw AppError.badRequest('NO_FILE', 'No file was sent', [{ field: 'file', message: 'Attach the file' }]);
    return { fields, file };
  }
}
