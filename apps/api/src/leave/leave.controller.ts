import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import { HolidaysService } from './holidays.service.js';
import {
  BalancesQueryDto,
  CreateHolidayDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  DecisionDto,
  ListHolidaysDto,
  ListLeaveRequestsDto,
  UpdateHolidayDto,
  UpdateLeaveTypeDto,
} from './leave.dto.js';
import { LeaveService } from './leave.service.js';

/** Anyone who takes part in leave can see the holidays and the kinds of leave. */
const CAN_VIEW = ['leave.request', 'leave.read', 'leave.settings'];

@ApiTags('leave')
@ApiBearerAuth()
@Controller()
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly holidays: HolidaysService,
  ) {}

  // -------------------------------------------------------------- holidays

  @RequireAnyPermission(...CAN_VIEW)
  @Get('holidays')
  listHolidays(@CurrentAuth() auth: AuthContext, @Query() query: ListHolidaysDto) {
    return this.holidays.list(auth, query.year);
  }

  @RequirePermissions('leave.settings')
  @Post('holidays')
  createHoliday(@CurrentAuth() auth: AuthContext, @Body() body: CreateHolidayDto) {
    return this.holidays.create(auth, body);
  }

  @RequirePermissions('leave.settings')
  @Patch('holidays/:id')
  updateHoliday(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateHolidayDto) {
    return this.holidays.update(auth, id, body);
  }

  @RequirePermissions('leave.settings')
  @Delete('holidays/:id')
  @HttpCode(204)
  removeHoliday(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.holidays.remove(auth, id);
  }

  // ----------------------------------------------------------------- types

  @RequireAnyPermission(...CAN_VIEW)
  @Get('leave/types')
  listTypes(@CurrentAuth() auth: AuthContext) {
    return this.leave.listTypes(auth, auth.permissions.has('leave.settings'));
  }

  @RequirePermissions('leave.settings')
  @Post('leave/types')
  createType(@CurrentAuth() auth: AuthContext, @Body() body: CreateLeaveTypeDto) {
    return this.leave.createType(auth, body);
  }

  @RequirePermissions('leave.settings')
  @Patch('leave/types/:id')
  updateType(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLeaveTypeDto) {
    return this.leave.updateType(auth, id, body);
  }

  // -------------------------------------------------------------- balances

  /** Own balances. `userId` shows someone else's, for those who manage leave. */
  @RequirePermissions('leave.request')
  @Get('leave/balances')
  balances(@CurrentAuth() auth: AuthContext, @Query() query: BalancesQueryDto) {
    return this.leave.balances(auth, query);
  }

  // -------------------------------------------------------------- requests

  @RequirePermissions('leave.request')
  @Post('leave/requests')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateLeaveRequestDto) {
    return this.leave.create(auth, body);
  }

  @RequirePermissions('leave.request')
  @Get('leave/requests/mine')
  mine(@CurrentAuth() auth: AuthContext, @Query() query: ListLeaveRequestsDto) {
    return this.leave.listMine(auth, query);
  }

  /** Requests of the people the caller manages. */
  @RequirePermissions('leave.read')
  @Get('leave/requests')
  forApproval(@CurrentAuth() auth: AuthContext, @Query() query: ListLeaveRequestsDto) {
    return this.leave.listForApproval(auth, query);
  }

  @RequirePermissions('leave.approve')
  @Post('leave/requests/:id/decision')
  @HttpCode(200)
  decide(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecisionDto) {
    return this.leave.decide(auth, id, body);
  }

  @RequirePermissions('leave.request')
  @Post('leave/requests/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leave.cancel(auth, id);
  }
}
