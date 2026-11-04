import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from './auth-context.js';
import { AllowMfaSetup, CurrentAuth, RequirePermissions } from './decorators.js';
import { MfaService } from './mfa.service.js';

const password = z.string().min(1).max(128);
/** A 6-digit app code, or a recovery code such as abcde-23456. */
const code = z.string().trim().min(6).max(16);

class SetupDto extends createZodDto(z.object({ password })) {}
class EnableDto extends createZodDto(z.object({ code })) {}
class DisableDto extends createZodDto(z.object({ password, code })) {}

/** A person's own two-step sign-in. Every signed-in person may use it. */
@ApiTags('auth')
@ApiBearerAuth()
@Controller()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @AllowMfaSetup()
  @Get('auth/mfa')
  status(@CurrentAuth() auth: AuthContext) {
    return this.mfa.status(auth);
  }

  /** Step 1. Needs the password. Returns the secret and the address for the QR code. */
  @AllowMfaSetup()
  @Post('auth/mfa/setup')
  @HttpCode(200)
  setup(@CurrentAuth() auth: AuthContext, @Body() body: SetupDto) {
    return this.mfa.beginSetup(auth, body.password);
  }

  /** Step 2. The first code from the app. Returns the recovery codes, once. */
  @AllowMfaSetup()
  @Post('auth/mfa/enable')
  @HttpCode(200)
  enable(@CurrentAuth() auth: AuthContext, @Body() body: EnableDto) {
    return this.mfa.enable(auth, body.code);
  }

  @Post('auth/mfa/disable')
  @HttpCode(200)
  disable(@CurrentAuth() auth: AuthContext, @Body() body: DisableDto) {
    return this.mfa.disable(auth, body);
  }

  /** For someone who lost their phone. */
  @RequirePermissions('user.manage')
  @Post('users/:id/mfa/reset')
  @HttpCode(200)
  reset(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.mfa.resetFor(auth, id);
  }
}
