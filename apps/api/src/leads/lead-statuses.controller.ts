import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import { LeadStatusesService } from './lead-statuses.service.js';
import { CreateStatusDto, CreateSubstatusDto, UpdateStatusDto } from './leads.dto.js';

class RenameSubstatusDto extends createZodDto(z.object({ name: z.string().trim().min(2).max(60) })) {}

@ApiTags('lead statuses')
@ApiBearerAuth()
@Controller()
export class LeadStatusesController {
  constructor(private readonly statuses: LeadStatusesService) {}

  /** The statuses to choose from. Those who manage settings also see the ones switched off. */
  @RequireAnyPermission('lead.read', 'settings.manage')
  @Get('lead-statuses')
  list(@CurrentAuth() auth: AuthContext) {
    return this.statuses.list(auth, auth.permissions.has('settings.manage'));
  }

  @RequirePermissions('settings.manage')
  @Post('lead-statuses')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateStatusDto) {
    return this.statuses.create(auth, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('lead-statuses/:id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateStatusDto) {
    return this.statuses.update(auth, id, body);
  }

  @RequirePermissions('settings.manage')
  @Post('lead-statuses/:id/substatuses')
  createSubstatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateSubstatusDto) {
    return this.statuses.createSubstatus(auth, id, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('lead-substatuses/:id')
  renameSubstatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RenameSubstatusDto) {
    return this.statuses.renameSubstatus(auth, id, body.name);
  }

  @RequirePermissions('settings.manage')
  @Delete('lead-substatuses/:id')
  @HttpCode(204)
  removeSubstatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.statuses.removeSubstatus(auth, id);
  }
}
