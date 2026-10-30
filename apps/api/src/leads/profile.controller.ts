import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { UpdateProfileDto } from './profile.dto.js';
import { ProfileService } from './profile.service.js';

@ApiTags('lead profile')
@ApiBearerAuth()
@Controller('leads/:id/profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @RequirePermissions('lead.read')
  @Get()
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.profile.get(auth, id);
  }

  /** Changes the sections sent: personal, preferences, guardians, education, exams. */
  @RequirePermissions('lead.update')
  @Patch()
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateProfileDto) {
    return this.profile.update(auth, id, body);
  }
}

class SuggestDto extends createZodDto(z.object({ field: z.enum(['board', 'institution', 'occupation', 'exam']) })) {}

@ApiTags('lead profile')
@ApiBearerAuth()
@Controller('lead-suggestions')
export class SuggestionsController {
  constructor(private readonly profile: ProfileService) {}

  /** Values already used on other leads, to offer as a drop-down while typing. */
  @RequirePermissions('lead.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: SuggestDto) {
    return this.profile.suggestions(auth, q.field);
  }
}
