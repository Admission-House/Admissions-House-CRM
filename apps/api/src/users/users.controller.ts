import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('user.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListUsersDto) {
    return this.users.list(auth, query);
  }

  @RequirePermissions('user.read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(auth, id);
  }

  /** Creates the person with a one-time password. It is shown once, in this response. */
  @RequirePermissions('user.manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateUserDto, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    return this.users.create(auth, body);
  }

  @RequirePermissions('user.manage')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateUserDto) {
    return this.users.update(auth, id, body);
  }

  /** New one-time password; the person is signed out everywhere and must choose their own. */
  @RequirePermissions('user.manage')
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.users.resetPassword(auth, id);
  }
}
