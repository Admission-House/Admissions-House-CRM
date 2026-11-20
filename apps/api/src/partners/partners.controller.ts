import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { PartnersService, sendSchema } from './partners.service.js';

class SendDto extends createZodDto(sendSchema) {}
class CitiesQuery extends createZodDto(z.object({ state: z.string().trim().min(1).max(80) })) {}

@ApiTags('partners')
@ApiBearerAuth()
@Controller()
export class PartnersController {
  constructor(private readonly partners: PartnersService) {}

  /** Colleges a lead can be sent to, with their courses and states. */
  @RequirePermissions('lead.read')
  @Get('partners')
  list() {
    return this.partners.list();
  }

  @RequirePermissions('lead.read')
  @Get('partners/:key/cities')
  cities(@Param('key') key: string, @Query() q: CitiesQuery) {
    return this.partners.cities(key, q.state);
  }

  /** What has been sent to colleges for this lead, newest first. */
  @RequirePermissions('lead.read')
  @Get('leads/:id/partner-submissions')
  submissions(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.partners.submissions(auth, id);
  }

  /** Sends the lead's details to the college. A student's data leaves the CRM, so it needs the right to update the lead. */
  @RequirePermissions('lead.update')
  @Post('leads/:id/partners/:key/send')
  @HttpCode(200)
  send(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() body: SendDto) {
    return this.partners.send(auth, id, key, body);
  }
}
