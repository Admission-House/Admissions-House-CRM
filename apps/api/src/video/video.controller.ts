import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { callSchema, guestJoinSchema, guestPresenceSchema, historyQuerySchema, inviteSchema, leadSessionSchema, meetingSchema, presenceSchema, respondSchema } from './video.dto.js';
import { VideoAccessService } from './video-access.service.js';
import { VideoService } from './video.service.js';

class LeadSessionDto extends createZodDto(leadSessionSchema) {}
class CallDto extends createZodDto(callSchema) {}
class MeetingDto extends createZodDto(meetingSchema) {}
class InviteDto extends createZodDto(inviteSchema) {}
class RespondDto extends createZodDto(respondSchema) {}
class PresenceDto extends createZodDto(presenceSchema) {}
class HistoryDto extends createZodDto(historyQuerySchema) {}
class GuestJoinDto extends createZodDto(guestJoinSchema) {}
class GuestPresenceDto extends createZodDto(guestPresenceSchema) {}

/**
 * Voice calls, video calls and group meetings for staff. All of them are one thing in the system: a session
 * with people invited to it. Who may do what is decided here on the server; the screens only follow.
 */
@ApiTags('communications')
@ApiBearerAuth()
@Controller()
export class VideoController {
  constructor(
    private readonly sessions: VideoService,
    private readonly access: VideoAccessService,
  ) {}

  // The fixed addresses come before ":id" so that "usage" is not read as a session id.

  /** Whether calls and meetings are set up, so the screens show their buttons only when they work. */
  @RequirePermissions('video.host')
  @Get('communications/status')
  status() {
    return this.sessions.status();
  }

  @RequirePermissions('video.host')
  @Get('communications/usage')
  usage(@CurrentAuth() auth: AuthContext) {
    return this.sessions.usage(auth);
  }

  /** Colleagues who can be called, and who is busy. */
  @RequirePermissions('video.host')
  @Get('communications/colleagues')
  colleagues(@CurrentAuth() auth: AuthContext) {
    return this.sessions.colleagues(auth);
  }

  /** What is ringing for me right now. */
  @RequirePermissions('video.host')
  @Get('communications/incoming')
  incoming(@CurrentAuth() auth: AuthContext) {
    return this.access.incoming(auth);
  }

  /** History of calls and meetings, with filters. Everyone sees what their role allows. */
  @RequirePermissions('video.host')
  @Get('communications')
  history(@CurrentAuth() auth: AuthContext, @Query() query: HistoryDto) {
    return this.sessions.history(auth, query);
  }

  @RequirePermissions('video.host')
  @Post('communications/calls')
  @HttpCode(201)
  call(@CurrentAuth() auth: AuthContext, @Body() body: CallDto) {
    return this.sessions.callColleague(auth, body);
  }

  @RequirePermissions('video.host')
  @Post('communications/meetings')
  @HttpCode(201)
  meeting(@CurrentAuth() auth: AuthContext, @Body() body: MeetingDto) {
    return this.sessions.createMeeting(auth, body);
  }

  @RequirePermissions('video.host')
  @Get('communications/:id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(auth, id);
  }

  /** A token for the channel. Ask again a little before it ends to stay in. */
  @RequirePermissions('video.host')
  @Post('communications/:id/join')
  @HttpCode(200)
  join(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.access.join(auth, id);
  }

  /** The screen reports that it is connected, still here, or gone. */
  @RequirePermissions('video.host')
  @Post('communications/:id/presence')
  @HttpCode(200)
  presence(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: PresenceDto) {
    return this.access.presence(auth, id, body.event);
  }

  /** Accept or turn down a ring or an invitation. */
  @RequirePermissions('video.host')
  @Post('communications/:id/respond')
  @HttpCode(200)
  respond(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RespondDto) {
    return this.access.respond(auth, id, body.action);
  }

  @RequirePermissions('video.host')
  @Post('communications/:id/end')
  @HttpCode(200)
  end(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.end(auth, id);
  }

  @RequirePermissions('video.host')
  @Post('communications/:id/invites')
  @HttpCode(201)
  invite(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: InviteDto) {
    return this.sessions.addInvite(auth, id, body);
  }

  @RequirePermissions('video.host')
  @Post('communications/:id/invites/:inviteId/remove')
  @HttpCode(200)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('inviteId', ParseUUIDPipe) inviteId: string) {
    return this.sessions.removeInvite(auth, id, inviteId);
  }

  @RequirePermissions('video.host')
  @Post('communications/:id/invites/:inviteId/reset-device')
  @HttpCode(200)
  resetDevice(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('inviteId', ParseUUIDPipe) inviteId: string) {
    return this.sessions.resetDevice(auth, id, inviteId);
  }

  /** A call with the lead, started from the lead's page. */
  @RequirePermissions('video.host')
  @Post('leads/:id/communications')
  @HttpCode(201)
  startForLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LeadSessionDto) {
    return this.sessions.startForLead(auth, id, body);
  }

  @RequirePermissions('video.host')
  @Get('leads/:id/communications')
  forLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.forLead(auth, id);
  }
}

/** The outside guest's way in. No sign-in: their own invitation link, from the device they first used. */
@ApiTags('communications')
@Public()
@Controller('video/guest')
export class GuestVideoController {
  constructor(private readonly access: VideoAccessService) {}

  @Post('join')
  @HttpCode(200)
  join(@Body() body: GuestJoinDto, @Req() req: FastifyRequest) {
    return this.access.guestJoin(body.token, body.deviceId, body.name, req.ip);
  }

  @Post('presence')
  @HttpCode(200)
  presence(@Body() body: GuestPresenceDto, @Req() req: FastifyRequest) {
    return this.access.guestPresence(body.token, body.deviceId, body.event, req.ip);
  }
}
