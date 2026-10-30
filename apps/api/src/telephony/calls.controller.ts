import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { sendFile } from '../documents/file-response.js';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { pageQuerySchema } from '../common/pagination.js';
import { ListCallsDto, PlaceCallDto, WrapUpDto } from './calls.dto.js';
import { CallsService } from './calls.service.js';

class PageDto extends createZodDto(pageQuerySchema) {}

@ApiTags('calls')
@ApiBearerAuth()
@Controller()
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  /** Starts a call to the lead: the provider rings the counsellor's own phone, then connects the student. */
  @RequirePermissions('call.place', 'lead.read')
  @Post('leads/:id/call')
  @HttpCode(202)
  place(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PlaceCallDto) {
    return this.calls.place(auth, id, body);
  }

  @RequirePermissions('call.read', 'lead.read')
  @Get('leads/:id/calls')
  forLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: PageDto) {
    return this.calls.forLead(auth, id, query);
  }

  @RequirePermissions('call.read')
  @Get('calls')
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListCallsDto) {
    return this.calls.list(auth, query);
  }

  @RequirePermissions('call.read')
  @Get('calls/:id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.get(auth, id);
  }

  /** The recording itself, for a client that can send its login header. */
  @RequirePermissions('call.listen')
  @Get('calls/:id/recording')
  async recording(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.calls.recording(auth, id);
    return sendFile(reply, file, file.type, file.name);
  }

  /** A link that plays the recording in a browser audio player, valid for a few minutes. */
  @RequirePermissions('call.listen')
  @Post('calls/:id/recording/link')
  @HttpCode(200)
  recordingLink(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.calls.recordingLink(auth, id);
  }

  /** The after-call form: status, remark and next follow-up. */
  @RequirePermissions('lead.update')
  @Post('calls/:id/wrap-up')
  @HttpCode(200)
  wrapUp(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: WrapUpDto) {
    return this.calls.wrapUp(auth, id, body);
  }
}
