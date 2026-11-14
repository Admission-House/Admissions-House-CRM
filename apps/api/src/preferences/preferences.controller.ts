import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { NOTIFY_KINDS, START_PAGE_KEYS } from './preferences-rules.js';
import { PreferencesService } from './preferences.service.js';

const updateSchema = z
  .object({
    startPage: z.enum(START_PAGE_KEYS).nullable().optional(),
    notify: z.object(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, z.boolean().optional()])) as Record<(typeof NOTIFY_KINDS)[number], z.ZodOptional<z.ZodBoolean>>).strict().optional(),
  })
  .strict();
// A data URL of a 64 KB picture is about 88,000 characters; anything longer is refused before it is decoded.
const avatarSchema = z.object({ image: z.string().max(90_000) }).strict();

class UpdateDto extends createZodDto(updateSchema) {}
class AvatarDto extends createZodDto(avatarSchema) {}

@ApiTags('preferences')
@ApiBearerAuth()
@Controller()
export class PreferencesController {
  constructor(private readonly prefs: PreferencesService) {}

  /** The signed-in person's own settings: start page, alert switches, whether they have a photo. */
  @Get('me/preferences')
  get(@CurrentAuth() auth: AuthContext) {
    return this.prefs.get(auth);
  }

  @Put('me/preferences')
  update(@CurrentAuth() auth: AuthContext, @Body() body: UpdateDto) {
    return this.prefs.update(auth, body);
  }

  @Put('me/avatar')
  setAvatar(@CurrentAuth() auth: AuthContext, @Body() body: AvatarDto) {
    return this.prefs.setAvatar(auth, body.image);
  }

  @Delete('me/avatar')
  @HttpCode(200)
  removeAvatar(@CurrentAuth() auth: AuthContext) {
    return this.prefs.removeAvatar(auth);
  }

  /** A colleague's photo, for avatars across the screens. */
  @Get('users/:id/avatar')
  async avatar(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const pic = await this.prefs.avatarOf(auth, id);
    void reply.header('content-type', pic.type);
    void reply.header('content-length', pic.bytes.length);
    void reply.header('cache-control', 'private, max-age=300');
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('content-security-policy', "default-src 'none'; sandbox");
    return new StreamableFile(pic.bytes);
  }
}
