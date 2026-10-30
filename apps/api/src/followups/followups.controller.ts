import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { CreateFollowUpDto, DoneDto, ListFollowUpsDto, RescheduleDto } from './followups.dto.js';
import { FollowUpsService } from './followups.service.js';

class SummaryQueryDto extends createZodDto(z.object({ userId: z.uuid().optional() })) {}

@ApiTags('follow-ups')
@ApiBearerAuth()
@Controller()
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @RequirePermissions('lead.read')
  @Get('leads/:id/followups')
  forLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.followUps.forLead(auth, id);
  }

  @RequirePermissions('followup.manage')
  @Post('leads/:id/followups')
  create(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateFollowUpDto) {
    return this.followUps.create(auth, id, body);
  }

  /** Follow-ups to do, in one bucket: today, overdue, upcoming or done. */
  @RequirePermissions('followup.manage')
  @Get('followups')
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListFollowUpsDto) {
    return this.followUps.list(auth, query);
  }

  @RequirePermissions('followup.manage')
  @Get('followups/summary')
  summary(@CurrentAuth() auth: AuthContext, @Query() query: SummaryQueryDto) {
    return this.followUps.summary(auth, query.userId);
  }

  @RequirePermissions('followup.manage')
  @Patch('followups/:id')
  reschedule(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RescheduleDto) {
    return this.followUps.reschedule(auth, id, body);
  }

  @RequirePermissions('followup.manage')
  @Post('followups/:id/done')
  @HttpCode(200)
  done(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DoneDto) {
    return this.followUps.done(auth, id, body.note);
  }

  @RequirePermissions('followup.manage')
  @Delete('followups/:id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.followUps.remove(auth, id);
  }
}
