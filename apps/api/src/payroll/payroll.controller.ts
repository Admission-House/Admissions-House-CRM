import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto, ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { pageQuerySchema } from '../common/pagination.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { readForm } from '../storage/multipart.js';
import { PayrollService } from './payroll.service.js';

const money = z.number().min(0).max(99_999_999).multipleOf(0.01);
const month = z.string().trim();
const salary = z.object({
  userId: z.uuid(),
  basePay: money,
  allowances: money.default(0),
  deductions: money.default(0),
  notes: z.string().trim().max(500).nullable().optional(),
});

class SaveDto extends createZodDto(salary.extend({ month })) {}
class BulkDto extends createZodDto(z.object({ month, rows: z.array(salary).min(1).max(500) })) {}
class ListDto extends createZodDto(pageQuerySchema.extend({ month: month.optional(), userId: z.uuid().optional(), roleId: z.uuid().optional() })) {}
class ReportDto extends createZodDto(z.object({ month: month.optional(), userId: z.uuid().optional(), roleId: z.uuid().optional(), format: z.enum(['csv', 'xlsx']).default('csv') })) {}
const importFields = z.object({ month });

@ApiTags('payroll')
@ApiBearerAuth()
@Controller('salaries')
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Adds or changes one employee's salary for a month. */
  @RequirePermissions('salary.write')
  @Put()
  save(@CurrentAuth() auth: AuthContext, @Body() body: SaveDto) {
    return this.payroll.save(auth, body);
  }

  /** Several employees for one month. All are saved, or none. */
  @RequirePermissions('salary.write')
  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentAuth() auth: AuthContext, @Body() body: BulkDto) {
    return this.payroll.saveMany(auth, body.month, body.rows);
  }

  /** What importing a salary sheet would do. Nothing is saved. */
  @RequirePermissions('salary.import')
  @ApiConsumes('multipart/form-data')
  @Post('import/preview')
  @HttpCode(200)
  async preview(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    return this.payroll.importSheet(auth, await this.read(req), false);
  }

  @RequirePermissions('salary.import')
  @ApiConsumes('multipart/form-data')
  @Post('import')
  @HttpCode(200)
  async import(@CurrentAuth() auth: AuthContext, @Req() req: FastifyRequest) {
    return this.payroll.importSheet(auth, await this.read(req), true);
  }

  @RequirePermissions('salary.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListDto) {
    return this.payroll.list(auth, query);
  }

  /** The monthly salary report as a CSV or Excel file. */
  @RequirePermissions('salary.read')
  @Get('report')
  async report(@CurrentAuth() auth: AuthContext, @Query() query: ReportDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.payroll.report(auth, query);
    reply.header('content-type', file.contentType).header('content-disposition', `attachment; filename="${file.fileName}"`).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    return file.body;
  }

  /** The signed-in person's own salary records. */
  @RequirePermissions('salary.read_own')
  @Get('mine')
  mine(@CurrentAuth() auth: AuthContext) {
    return this.payroll.mine(auth);
  }

  @RequireAnyPermission('salary.read', 'salary.read_own')
  @Get(':id')
  detail(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.detail(auth, id);
  }

  @RequireAnyPermission('salary.read', 'salary.read_own')
  @Get(':id/payslip.pdf')
  async payslip(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.payroll.payslip(auth, id);
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${file.fileName}"`).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    return file.pdf;
  }

  private async read(req: FastifyRequest) {
    const { fields, file } = await readForm(req, this.env.MAX_UPLOAD_BYTES);
    if (!file) throw AppError.badRequest('NO_FILE', 'No file was sent', [{ field: 'file', message: 'Attach the file' }]);
    const parsed = importFields.safeParse(fields);
    if (!parsed.success) throw new ZodValidationException(parsed.error);
    return { month: parsed.data.month, fileName: file.filename, data: file.data };
  }
}
