import { Body, Controller, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { connectionSchema, TelephonySettingsService } from './telephony-settings.service.js';

class ConnectionDto extends createZodDto(connectionSchema) {}

@ApiTags('telephony')
@ApiBearerAuth()
@RequirePermissions('integration.manage')
@Controller('telephony/connection')
export class TelephonySettingsController {
  constructor(private readonly settings: TelephonySettingsService) {}

  /** The connection, or null if none is set up. Credentials are never returned. */
  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.settings.get(auth);
  }

  /** The webhook key appears in this response only, and only when the connection is first created. */
  @Put()
  save(@CurrentAuth() auth: AuthContext, @Body() body: ConnectionDto, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return this.settings.save(auth, body);
  }

  @Post('rotate-key')
  @HttpCode(200)
  rotate(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return this.settings.rotateKey(auth);
  }
}
