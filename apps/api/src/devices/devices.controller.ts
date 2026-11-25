import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { pageQuerySchema } from '../common/pagination.js';
import { OfficeComputersService } from '../auth/office-computers.service.js';
import { DevicesService } from './devices.service.js';

class ListComputersDto extends createZodDto(
  z.object({ state: z.enum(['pending', 'approved']).default('pending') }),
) {}

class ListDevicesDto extends createZodDto(
  pageQuerySchema.extend({ status: z.enum(['pending', 'approved', 'all']).default('pending') }),
) {}

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Phones of the people the caller manages. By default, those waiting for approval. */
  @RequirePermissions('device.approve')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListDevicesDto) {
    return this.devices.list(auth, query);
  }

  @RequirePermissions('device.approve')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.devices.approve(auth, id);
  }

  @RequirePermissions('device.approve')
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.devices.revoke(auth, id);
  }
}

/** The computers people sign in from at the office. A new one waits here until a Super Admin or Admin approves it. */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('office-computers')
export class OfficeComputersController {
  constructor(private readonly computers: OfficeComputersService) {}

  @RequirePermissions('device.approve')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListComputersDto) {
    return this.computers.list(auth, query.state);
  }

  @RequirePermissions('device.approve')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.computers.approve(auth, id);
  }

  @RequirePermissions('device.approve')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.computers.deny(auth, id, 'reject');
  }

  @RequirePermissions('device.approve')
  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.computers.deny(auth, id, 'remove');
  }
}
