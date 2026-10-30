import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { CollegeApiService } from './college-api.service.js';

@ApiTags('masters')
@ApiBearerAuth()
@Controller('masters/college-api')
export class CollegeApiController {
  constructor(private readonly api: CollegeApiService) {}

  /** Whether the college data connection is set up, and how its fields are read. Never shows the key. */
  @RequirePermissions('master.manage')
  @Get()
  status() {
    return this.api.status();
  }

  /** What loading the provider's data would add or change. Nothing is saved. */
  @RequirePermissions('master.manage')
  @Post('preview')
  @HttpCode(200)
  preview(@CurrentAuth() auth: AuthContext) {
    return this.api.preview(auth);
  }

  /** Loads the provider's colleges, courses and fees, all together or not at all. */
  @RequirePermissions('master.manage')
  @Post('sync')
  @HttpCode(200)
  sync(@CurrentAuth() auth: AuthContext) {
    return this.api.sync(auth);
  }
}
