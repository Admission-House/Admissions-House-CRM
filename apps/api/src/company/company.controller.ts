import { Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { readForm } from '../storage/multipart.js';
import { companySchema, CompanyService, MAX_LOGO_BYTES } from './company.service.js';

class CompanyDto extends createZodDto(companySchema) {}

@ApiTags('company')
@ApiBearerAuth()
@Controller('company')
export class CompanyController {
  constructor(
    private readonly company: CompanyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Anyone signed in may read their company's look (name, colours), to draw the screens. */
  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.company.get(auth);
  }

  @RequirePermissions('settings.manage')
  @Put()
  update(@CurrentAuth() auth: AuthContext, @Body() body: CompanyDto) {
    return this.company.update(auth, body);
  }

  @Get('logo')
  async logo(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<StreamableFile> {
    const file = await this.company.logo(auth);
    if (!file) throw AppError.notFound('Logo');
    void reply.header('content-type', file.mime);
    void reply.header('content-length', file.size);
    void reply.header('cache-control', 'private, max-age=300');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('content-security-policy', "default-src 'none'; sandbox");
    return new StreamableFile(file.stream);
  }

  @RequirePermissions('settings.manage')
  @ApiConsumes('multipart/form-data')
  @Post('logo')
  @HttpCode(200)
  async setLogo(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    const { file } = await readForm(req, Math.min(this.env.MAX_UPLOAD_BYTES, MAX_LOGO_BYTES + 1));
    if (!file) throw AppError.badRequest('NO_FILE', 'No file was sent', [{ field: 'file', message: 'Attach the picture' }]);
    return this.company.setLogo(auth, file.data);
  }

  @RequirePermissions('settings.manage')
  @Delete('logo')
  removeLogo(@CurrentAuth() auth: AuthContext) {
    return this.company.removeLogo(auth);
  }
}
