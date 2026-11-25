import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import type { AuthContext } from './auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from './decorators.js';
import { loginSchema } from './dto/auth.dto.js';
import { RemoteSigninService } from './remote-signin.service.js';

const statusSchema = z.object({
  tenant: loginSchema.shape.tenant,
  requestId: z.uuid(),
  token: z.string().min(20).max(64),
});
class StatusDto extends createZodDto(statusSchema) {}
const listSchema = z.object({ state: z.enum(['pending', 'decided']).default('pending') });
class ListDto extends createZodDto(listSchema) {}

/**
 * Sign-in from outside the office with approval. The waiting browser asks how its request stands (with the token it was given);
 * Super Admins and Admins (attendance exceptions) see the requests of the people in their reach and answer them.
 */
@ApiTags('auth')
@Controller()
export class RemoteSigninController {
  constructor(
    private readonly remote: RemoteSigninService,
    private readonly db: DatabaseService,
  ) {}

  @Public()
  @Post('auth/remote-signin/status')
  @HttpCode(200)
  async status(@Body() body: StatusDto) {
    const { rows } = await sql<{
      id: string;
      status: string;
    }>`SELECT id, status FROM find_tenant_by_slug(${body.tenant})`.execute(this.db.unscoped());
    const tenant = rows[0];
    if (!tenant || tenant.status !== 'active') throw AppError.notFound('Request');
    return this.db.withTenant(tenant.id, (trx) =>
      this.remote.status(trx, body.requestId, body.token),
    );
  }

  @ApiBearerAuth()
  @RequirePermissions('attendance.exception')
  @Get('remote-signins')
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListDto) {
    return this.remote.list(auth, query.state);
  }

  @ApiBearerAuth()
  @RequirePermissions('attendance.exception')
  @Post('remote-signins/:id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.remote.decide(auth, id, 'approved');
  }

  @ApiBearerAuth()
  @RequirePermissions('attendance.exception')
  @Post('remote-signins/:id/reject')
  @HttpCode(200)
  reject(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.remote.decide(auth, id, 'rejected');
  }
}
