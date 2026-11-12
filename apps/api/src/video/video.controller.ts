import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { VideoService } from './video.service.js';

class CreateSessionDto extends createZodDto(
  z.object({
    /** When the session is planned for. Without it the session can be joined straight away. */
    scheduledFor: z.iso.datetime({ offset: true }).optional(),
    maxMinutes: z.number().int().min(5).max(240).default(45),
  }),
) {}

class GuestJoinDto extends createZodDto(z.object({ token: z.string().trim().min(40).max(200) })) {}

/** Video counselling for staff: open a session for a lead, join it, end it. */
@ApiTags('video')
@ApiBearerAuth()
@Controller()
export class VideoController {
  constructor(private readonly video: VideoService) {}

  /** Whether video is set up, so the lead screen shows the button only when it works. */
  @RequirePermissions('video.host')
  @Get('video-sessions/status')
  status() {
    return this.video.status();
  }

  @RequirePermissions('video.host')
  @Get('video-sessions/usage')
  usage(@CurrentAuth() auth: AuthContext) {
    return this.video.usage(auth);
  }

  @RequirePermissions('video.host')
  @Post('leads/:id/video-sessions')
  @HttpCode(201)
  create(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateSessionDto) {
    return this.video.create(auth, id, body);
  }

  @RequirePermissions('video.host')
  @Get('leads/:id/video-sessions')
  list(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.video.list(auth, id);
  }

  /** Gives a staff member the channel and a short-lived token for the session. */
  @RequirePermissions('video.host')
  @Post('video-sessions/:id/join')
  @HttpCode(200)
  join(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.video.join(auth, id);
  }

  @RequirePermissions('video.host')
  @Post('video-sessions/:id/end')
  @HttpCode(200)
  end(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.video.end(auth, id);
  }
}

/** The student's way in. No sign-in: the link they were sent is the credential. */
@ApiTags('video')
@Public()
@Controller('video/guest')
export class GuestVideoController {
  constructor(private readonly video: VideoService) {}

  @Post('join')
  @HttpCode(200)
  join(@Body() body: GuestJoinDto, @Req() req: FastifyRequest) {
    return this.video.guestJoin(body.token, req.ip);
  }
}
