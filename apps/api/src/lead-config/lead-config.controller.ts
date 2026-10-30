import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import { CreateRuleDto, CreateSourceDto, PolicyDto, UpdateRuleDto, UpdateSourceDto } from './lead-config.dto.js';
import { LeadConfigService } from './lead-config.service.js';

@ApiTags('lead settings')
@ApiBearerAuth()
@Controller()
export class LeadConfigController {
  constructor(private readonly config: LeadConfigService) {}

  // --------------------------------------------------------------- sources

  /** Where leads come from. Anyone who works with leads can see them (for filters). */
  @RequireAnyPermission('lead.read', 'settings.manage')
  @Get('lead-sources')
  listSources(@CurrentAuth() auth: AuthContext) {
    return this.config.listSources(auth, auth.permissions.has('settings.manage'));
  }

  @RequirePermissions('settings.manage')
  @Post('lead-sources')
  createSource(@CurrentAuth() auth: AuthContext, @Body() body: CreateSourceDto) {
    return this.config.createSource(auth, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('lead-sources/:id')
  updateSource(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSourceDto) {
    return this.config.updateSource(auth, id, body);
  }

  // ------------------------------------------------------------------ rules

  @RequirePermissions('settings.manage')
  @Get('assignment-rules')
  listRules(@CurrentAuth() auth: AuthContext) {
    return this.config.listRules(auth);
  }

  @RequirePermissions('settings.manage')
  @Post('assignment-rules')
  createRule(@CurrentAuth() auth: AuthContext, @Body() body: CreateRuleDto) {
    return this.config.createRule(auth, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('assignment-rules/:id')
  updateRule(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRuleDto) {
    return this.config.updateRule(auth, id, body);
  }

  @RequirePermissions('settings.manage')
  @Delete('assignment-rules/:id')
  @HttpCode(204)
  removeRule(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.config.removeRule(auth, id);
  }

  // ----------------------------------------------------------------- policy

  @RequirePermissions('settings.manage')
  @Get('lead-policy')
  getPolicy(@CurrentAuth() auth: AuthContext) {
    return this.config.getPolicy(auth);
  }

  @RequirePermissions('settings.manage')
  @Put('lead-policy')
  setPolicy(@CurrentAuth() auth: AuthContext, @Body() body: PolicyDto) {
    return this.config.setPolicy(auth, body);
  }
}
