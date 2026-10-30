import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ProfileService, selfProfileSchema, staffProfileSchema } from './profile.service.js';

class SelfDto extends createZodDto(selfProfileSchema) {}
class StaffDto extends createZodDto(staffProfileSchema) {}
class RevealDto extends createZodDto(z.object({ reveal: z.enum(['true', 'false']).transform((v) => v === 'true').optional() })) {}

@ApiTags('profile')
@ApiBearerAuth()
@Controller()
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  /** The signed-in person's own profile. `?reveal=true` shows the full bank account number. */
  @Get('me/profile')
  mine(@CurrentAuth() auth: AuthContext, @Query() q: RevealDto) {
    return this.profiles.get(auth, auth.userId, !!q.reveal);
  }

  /** A person may update their address, emergency contact and bank details. HR details are for those who manage people. */
  @Put('me/profile')
  updateMine(@CurrentAuth() auth: AuthContext, @Body() body: SelfDto) {
    return this.profiles.update(auth, auth.userId, body);
  }

  @Get('users/:id/profile')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: RevealDto) {
    return this.profiles.get(auth, id, !!q.reveal);
  }

  @Put('users/:id/profile')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: StaffDto) {
    return this.profiles.update(auth, id, body);
  }
}
