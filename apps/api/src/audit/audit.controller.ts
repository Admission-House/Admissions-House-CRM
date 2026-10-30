import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { calendarDate } from '../common/dates.js';
import { pageQuerySchema } from '../common/pagination.js';
import { AuditQueryService } from './audit-query.service.js';

class ListAuditDto extends createZodDto(
  pageQuerySchema.extend({
    actorId: z.uuid().optional(),
    action: z.string().trim().min(1).max(80).optional(),
    entity: z.string().trim().min(1).max(60).optional(),
    entityId: z.uuid().optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  }),
) {}

@ApiTags('audit')
@ApiBearerAuth()
@RequirePermissions('audit.read')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  /** What happened, by whom and when, newest first. There is no way to change or delete an entry. */
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListAuditDto) {
    return this.audit.list(auth, query);
  }

  @Get('actions')
  actions(@CurrentAuth() auth: AuthContext) {
    return this.audit.actions(auth);
  }
}
