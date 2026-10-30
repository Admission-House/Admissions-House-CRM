import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';
import {
  CreateBreakTypeDto,
  CreateExceptionDto,
  ListAttendanceDto,
  LocationLogDto,
  StartBreakDto,
  UpdateBreakTypeDto,
  UpdateSettingsDto,
} from './attendance.dto.js';
import { AttendanceService } from './attendance.service.js';
import { LocationLogService } from './location-log.service.js';

@ApiTags('attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly settings: AttendanceSettingsService,
    private readonly locationLog: LocationLogService,
  ) {}

  /** Today for the signed-in person: checked in or not, on a break or not, and the shift rules. */
  @RequirePermissions('attendance.self')
  @Get('me/today')
  today(@CurrentAuth() auth: AuthContext) {
    return this.attendance.today(auth);
  }

  /** The signed-in person's own attendance, newest day first. Needs no permission to look at others. */
  @RequirePermissions('attendance.self')
  @Get('me')
  mine(@CurrentAuth() auth: AuthContext, @Query() query: ListAttendanceDto) {
    return this.attendance.list(auth, { ...query, userId: auth.userId });
  }

  @RequirePermissions('attendance.self')
  @Get('break-types')
  breakTypes(@CurrentAuth() auth: AuthContext) {
    return this.settings.listBreakTypes(auth, false);
  }

  @RequirePermissions('attendance.self')
  @Post('breaks/start')
  @HttpCode(200)
  startBreak(@CurrentAuth() auth: AuthContext, @Body() body: StartBreakDto) {
    return this.attendance.startBreak(auth, body.breakTypeId);
  }

  @RequirePermissions('attendance.self')
  @Post('breaks/end')
  @HttpCode(200)
  endBreak(@CurrentAuth() auth: AuthContext) {
    return this.attendance.endBreak(auth);
  }

  /** Attendance of the people the caller manages, newest day first. */
  @RequirePermissions('attendance.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListAttendanceDto) {
    return this.attendance.list(auth, query);
  }

  /** Where people signed in from, and who was turned away at the door. Newest first. */
  @RequirePermissions('attendance.read')
  @Get('location-log')
  locations(@CurrentAuth() auth: AuthContext, @Query() query: LocationLogDto) {
    return this.locationLog.list(auth, query);
  }

  /** Marks someone present for a day they could not sign in from the office. A reason is required. */
  @RequirePermissions('attendance.exception')
  @Post('exceptions')
  createException(@CurrentAuth() auth: AuthContext, @Body() body: CreateExceptionDto) {
    return this.attendance.createException(auth, body);
  }

  @RequirePermissions('attendance.settings')
  @Get('settings')
  getSettings(@CurrentAuth() auth: AuthContext) {
    return this.settings.get(auth);
  }

  @RequirePermissions('attendance.settings')
  @Put('settings')
  updateSettings(@CurrentAuth() auth: AuthContext, @Body() body: UpdateSettingsDto) {
    return this.settings.update(auth, body);
  }

  @RequirePermissions('attendance.settings')
  @Post('break-types')
  createBreakType(@CurrentAuth() auth: AuthContext, @Body() body: CreateBreakTypeDto) {
    return this.settings.createBreakType(auth, body);
  }

  @RequirePermissions('attendance.settings')
  @Patch('break-types/:id')
  updateBreakType(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBreakTypeDto) {
    return this.settings.updateBreakType(auth, id, body);
  }
}
