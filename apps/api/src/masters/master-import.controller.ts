import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { mappingField } from '../imports/mapping-field.js';
import { readForm } from '../storage/multipart.js';
import { MasterImportService } from './master-import.service.js';
import { FIELDS } from './master-import-rules.js';

const fieldsSchema = z.object({ mapping: mappingField(FIELDS) });

@ApiTags('masters')
@ApiBearerAuth()
@Controller('masters/import')
export class MasterImportController {
  constructor(
    private readonly imports: MasterImportService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** What importing this file of colleges, courses and fees would add or change. Nothing is saved. */
  @RequirePermissions('master.manage')
  @ApiConsumes('multipart/form-data')
  @Post('preview')
  @HttpCode(200)
  async preview(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const { file, mapping } = await this.read(req);
    return this.imports.preview(auth, { data: file.data, mapping });
  }

  /** Adds and updates colleges, courses and fees from the file, all together or not at all. */
  @RequirePermissions('master.manage')
  @ApiConsumes('multipart/form-data')
  @Post()
  @HttpCode(200)
  async apply(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const { file, mapping } = await this.read(req);
    return this.imports.apply(auth, { data: file.data, fileName: file.filename, mapping });
  }

  private async read(req: FastifyRequest) {
    const { fields, file } = await readForm(req, this.env.MAX_UPLOAD_BYTES);
    if (!file) throw AppError.badRequest('NO_FILE', 'No file was sent', [{ field: 'file', message: 'Attach the file' }]);
    const parsed = fieldsSchema.safeParse(fields);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    return { file, mapping: parsed.data.mapping };
  }
}
