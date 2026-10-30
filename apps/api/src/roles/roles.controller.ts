import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { CreateRoleDto, UpdateRoleDto } from './roles.dto.js';
import { RolesService } from './roles.service.js';

@ApiTags('roles')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** The list of everything a role can be allowed to do. */
  @RequirePermissions('role.manage')
  @Get('permissions')
  permissions(@CurrentAuth() auth: AuthContext) {
    return this.roles.listPermissions(auth);
  }

  /** Role names, for choosing a role when creating or editing a person. */
  @RequirePermissions('user.read')
  @Get('roles')
  list(@CurrentAuth() auth: AuthContext) {
    return this.roles.list(auth);
  }

  @RequirePermissions('role.manage')
  @Get('roles/:id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(auth, id);
  }

  @RequirePermissions('role.manage')
  @Post('roles')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateRoleDto) {
    return this.roles.create(auth, body);
  }

  @RequirePermissions('role.manage')
  @Patch('roles/:id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRoleDto) {
    return this.roles.update(auth, id, body);
  }

  @RequirePermissions('role.manage')
  @Delete('roles/:id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.roles.remove(auth, id);
  }
}
