import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Heavy } from '../auth/decorators.js';
import { PushTokensService } from './push-tokens.service.js';

/** An Expo push token looks like ExponentPushToken[xxxxxxxx]. */
const token = z.string().trim().regex(/^(Exponent|Expo)PushToken\[[A-Za-z0-9_-]{10,}\]$/, 'This is not a push token');

class RegisterDto extends createZodDto(z.object({ token, platform: z.enum(['android', 'ios']) })) {}
class UnregisterDto extends createZodDto(z.object({ token })) {}

/** A person's own phones for alerts. Every signed-in person has them, so no extra permission is needed. */
@ApiTags('push')
@ApiBearerAuth()
@Controller('push-tokens')
export class PushTokensController {
  constructor(private readonly tokens: PushTokensService) {}

  @Post()
  @HttpCode(200)
  register(@CurrentAuth() auth: AuthContext, @Body() body: RegisterDto) {
    return this.tokens.register(auth, body);
  }

  @Post('remove')
  @HttpCode(200)
  remove(@CurrentAuth() auth: AuthContext, @Body() body: UnregisterDto) {
    return this.tokens.unregister(auth, body.token);
  }

  /** Sends a test alert to the person's own phones. */
  @Heavy()
  @Post('test')
  @HttpCode(200)
  test(@CurrentAuth() auth: AuthContext) {
    return this.tokens.sendTest(auth);
  }
}
