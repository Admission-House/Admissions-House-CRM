import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { DialerService } from './dialer.service.js';

class StartDto extends createZodDto(z.object({ leadIds: z.array(z.uuid()).min(1).max(200) })) {}
class ListDto extends createZodDto(
  z.object({ status: z.enum(['running', 'paused', 'stopped', 'finished']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }),
) {}

@ApiTags('dialer')
@ApiBearerAuth()
@RequirePermissions('dialer.use', 'call.place')
@Controller('dialer/sessions')
export class DialerController {
  constructor(private readonly dialer: DialerService) {}

  /** Starts a session over these leads, in this order. One running session per person. */
  @Post()
  start(@CurrentAuth() auth: AuthContext, @Body() body: StartDto) {
    return this.dialer.start(auth, body.leadIds);
  }

  /** The person's own running or paused session, or null. */
  @Get('current')
  current(@CurrentAuth() auth: AuthContext) {
    return this.dialer.current(auth);
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListDto) {
    return this.dialer.list(auth, query);
  }

  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.get(auth, id);
  }

  /** Places the call to the next lead. */
  @Post(':id/dial')
  @HttpCode(202)
  dial(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.dial(auth, id);
  }

  @Post(':id/skip')
  @HttpCode(200)
  skip(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.skip(auth, id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.pause(auth, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.resume(auth, id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  stop(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.dialer.stop(auth, id);
  }
}
