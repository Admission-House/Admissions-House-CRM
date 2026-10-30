import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AddNetworkDto, ConfirmDetectionDto, CreateBranchDto, DetectDto, UpdateBranchDto } from './branches.dto.js';
import { BranchesService } from './branches.service.js';

@ApiTags('branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @RequirePermissions('branch.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.branches.list(auth);
  }

  @RequirePermissions('branch.read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.branches.get(auth, id);
  }

  @RequirePermissions('branch.manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateBranchDto) {
    return this.branches.create(auth, body);
  }

  @RequirePermissions('branch.manage')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBranchDto) {
    return this.branches.update(auth, id, body);
  }

  @RequirePermissions('branch.manage')
  @Post(':id/networks')
  addNetwork(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AddNetworkDto) {
    return this.branches.addNetwork(auth, id, body);
  }

  @RequirePermissions('branch.manage')
  @Delete(':id/networks/:networkId')
  removeNetwork(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('networkId', ParseUUIDPipe) networkId: string,
  ) {
    return this.branches.removeNetwork(auth, id, networkId);
  }

  /** The Detect button, step one: shows what the server sees. Saves nothing. */
  @RequirePermissions('branch.manage')
  @Post(':id/detect')
  @HttpCode(200)
  detect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DetectDto) {
    return this.branches.detect(auth, id, body);
  }

  /** The Detect button, step two: saves the confirmed position and this network. */
  @RequirePermissions('branch.manage')
  @Post(':id/detect/confirm')
  @HttpCode(200)
  confirm(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ConfirmDetectionDto) {
    return this.branches.confirm(auth, id, body);
  }
}
