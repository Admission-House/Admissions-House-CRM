import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { pageQuerySchema } from '../common/pagination.js';
import { IntegrationsService } from './integrations.service.js';

class CreateKeyDto extends createZodDto(z.object({ name: z.string().trim().min(2).max(80), sourceId: z.uuid() })) {}
class ListEventsDto extends createZodDto(
  pageQuerySchema.extend({ status: z.enum(['received', 'processed', 'failed', 'ignored']).optional() }),
) {}

@ApiTags('integrations')
@ApiBearerAuth()
@RequirePermissions('integration.manage')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('api-keys')
  listKeys(@CurrentAuth() auth: AuthContext) {
    return this.integrations.listKeys(auth);
  }

  /** The key appears in this response only. Put it in the sender's settings straight away. */
  @Post('api-keys')
  createKey(@CurrentAuth() auth: AuthContext, @Body() body: CreateKeyDto, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return this.integrations.createKey(auth, body);
  }

  @Delete('api-keys/:id')
  @HttpCode(204)
  revokeKey(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.integrations.revokeKey(auth, id);
  }

  @Get('events')
  listEvents(@CurrentAuth() auth: AuthContext, @Query() query: ListEventsDto) {
    return this.integrations.listEvents(auth, query);
  }

  @Get('events/:id')
  getEvent(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.getEvent(auth, id);
  }

  @Post('events/:id/retry')
  @HttpCode(200)
  retry(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.retryEvent(auth, id);
  }
}
