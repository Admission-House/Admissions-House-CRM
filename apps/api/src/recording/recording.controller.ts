import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { RecordingService } from './recording.service.js';

class PolicyDto extends createZodDto(
  z.object({
    mode: z.enum(['off', 'optional', 'always']).optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    noticeText: z.string().trim().min(10).max(1000).optional(),
  }),
) {}
class LinkDto extends createZodDto(z.object({ purpose: z.enum(['play', 'download']).default('play') })) {}

/** The company's recording policy, and the recordings of calls and meetings, for staff. */
@ApiTags('recording')
@ApiBearerAuth()
@Controller()
export class RecordingController {
  constructor(private readonly recording: RecordingService) {}

  /** What is decided: whether sessions are recorded, the notice people see, how long recordings are kept. */
  @RequirePermissions('video.host')
  @Get('communications/recording/policy')
  policy(@CurrentAuth() auth: AuthContext) {
    return this.recording.getPolicy(auth);
  }

  @RequirePermissions('recording.manage')
  @Put('communications/recording/policy')
  update(@CurrentAuth() auth: AuthContext, @Body() body: PolicyDto) {
    return this.recording.updatePolicy(auth, body);
  }

  /** The recordings of one session, for those who may see the session. */
  @RequirePermissions('video.host')
  @Get('communications/:id/recordings')
  recordings(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.recording.forSession(auth, id);
  }

  /** A short-lived link to listen to, or save, one recording file. Written to the audit log. */
  @RequirePermissions('video.host')
  @Post('communications/:id/recordings/files/:fileId/link')
  @HttpCode(200)
  link(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('fileId', ParseUUIDPipe) fileId: string, @Body() body: LinkDto) {
    return this.recording.link(auth, id, fileId, body.purpose);
  }
}

const RANGE = /^bytes=(\d*)-(\d*)$/;

/** Agora's notices, and the signed links that play a recording. Neither has a signed-in person; each has its own proof. */
@ApiExcludeController()
@Public()
@Controller('recordings')
export class RecordingPublicController {
  constructor(private readonly recording: RecordingService) {}

  /** Agora tells us how a recording is going. Refused unless the signature over the exact body matches. */
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<FastifyRequest>, @Headers('agora-signature-v2') signature: string | undefined) {
    if (!req.rawBody) throw AppError.badRequest('NO_BODY', 'The notice has no body');
    return this.recording.handleNotice(req.rawBody, signature);
  }

  /** The recording behind a link made by the CRM. Shown or saved, never kept by caches, and skippable (partial requests). */
  @Get('files/:token')
  async file(@Param('token') token: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const asked = RANGE.exec(String(req.headers.range ?? ''));
    // Find the size first for a request like "bytes=100-" (until the end) or "bytes=-500" (the last 500).
    let range: { start: number; end: number } | undefined;
    if (asked && (asked[1] || asked[2])) {
      const probe = await this.recording.openLink(token, { start: 0, end: 0 });
      probe.stream.on('error', () => undefined);
      (probe.stream as { destroy?: () => void }).destroy?.();
      const total = probe.total;
      range = asked[1] ? { start: Number(asked[1]), end: asked[2] ? Math.min(Number(asked[2]), total - 1) : total - 1 } : { start: Math.max(0, total - Number(asked[2])), end: total - 1 };
      if (range.start > range.end || range.start >= total) {
        void reply.code(416).header('content-range', `bytes */${total}`);
        throw new AppError('RANGE_NOT_SATISFIABLE', 'That part of the recording does not exist.', 416);
      }
    }
    const file = await this.recording.openLink(token, range);
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    void reply.header('content-type', file.type);
    void reply.header('accept-ranges', 'bytes');
    void reply.header('content-length', file.size);
    if (file.partial && range) {
      void reply.code(206);
      void reply.header('content-range', `bytes ${range.start}-${range.end}/${file.total}`);
    }
    void reply.header('content-disposition', `${file.download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('content-security-policy', "default-src 'none'; sandbox");
    return new StreamableFile(file.stream as never);
  }
}
