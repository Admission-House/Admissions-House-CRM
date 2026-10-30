import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { calendarDate } from '../common/dates.js';
import { fileName, Report, toCsv, toXlsx } from './report-file.js';
import { ReportsService } from './reports.service.js';

const range = { from: calendarDate.optional(), to: calendarDate.optional(), format: z.enum(['json', 'csv', 'xlsx']).default('json') };
class RangeDto extends createZodDto(z.object(range)) {}
class UserRangeDto extends createZodDto(z.object({ ...range, userId: z.uuid().optional() })) {}
class TatDto extends createZodDto(z.object({ ...range, groupBy: z.enum(['user', 'source']).default('user') })) {}
class LeadsDto extends createZodDto(z.object({ ...range, groupBy: z.enum(['source', 'status', 'assignee', 'day']).default('source') })) {}
class MonthDto extends createZodDto(z.object({ month: z.string().trim(), format: z.enum(['json', 'csv', 'xlsx']).default('json') })) {}
class FormatDto extends createZodDto(z.object({ format: z.enum(['json', 'csv', 'xlsx']).default('json') })) {}

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Lead counts, follow-ups due, today's calls and, for those who manage people, the team. */
  @RequirePermissions('dashboard.read')
  @Get('dashboard')
  dashboard(@CurrentAuth() auth: AuthContext) {
    return this.reports.dashboard(auth);
  }

  @RequirePermissions('report.read')
  @Get('reports/team-status')
  teamStatus(@CurrentAuth() auth: AuthContext, @Query() q: FormatDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.teamStatus(auth));
  }

  @RequirePermissions('report.read')
  @Get('reports/tat')
  tat(@CurrentAuth() auth: AuthContext, @Query() q: TatDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.tat(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/productivity')
  productivity(@CurrentAuth() auth: AuthContext, @Query() q: UserRangeDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.productivity(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/leads')
  leads(@CurrentAuth() auth: AuthContext, @Query() q: LeadsDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.leadsBy(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/activity')
  activity(@CurrentAuth() auth: AuthContext, @Query() q: UserRangeDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.activity(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/calls')
  calls(@CurrentAuth() auth: AuthContext, @Query() q: RangeDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.calls(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/attendance')
  attendance(@CurrentAuth() auth: AuthContext, @Query() q: MonthDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.attendance(auth, q));
  }

  @RequirePermissions('report.read')
  @Get('reports/attendance-days')
  attendanceDays(@CurrentAuth() auth: AuthContext, @Query() q: MonthDto, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.send(auth, reply, q.format, this.reports.attendanceDays(auth, q));
  }

  /** The report on screen, or as a file for people who may export. */
  private async send(auth: AuthContext, reply: FastifyReply, format: 'json' | 'csv' | 'xlsx', pending: Promise<Report>) {
    if (format !== 'json' && !auth.permissions.has('report.export')) throw AppError.forbidden();
    const report = await pending;
    if (format === 'json') return report;
    const csv = format === 'csv';
    reply
      .header('content-type', csv ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${fileName(report, format)}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff');
    return csv ? toCsv(report) : await toXlsx(report);
  }
}
