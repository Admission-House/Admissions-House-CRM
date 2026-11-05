import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import { PayrollPolicyService, policySchema } from './payroll-policy.service.js';
import { addLineSchema, changeLineSchema, PayrollRunService, recalculateSchema, reopenSchema } from './payroll-run.service.js';
import { SalaryStructureService, structureSchema } from './salary-structure.service.js';

class PolicyDto extends createZodDto(policySchema) {}
class StructureDto extends createZodDto(structureSchema) {}
class StructureQueryDto extends createZodDto(z.object({ month: z.string().trim().optional() })) {}
class CreateRunDto extends createZodDto(z.object({ month: z.string().trim() })) {}
class RecalculateDto extends createZodDto(recalculateSchema) {}
class ReopenDto extends createZodDto(reopenSchema) {}
class ChangeLineDto extends createZodDto(changeLineSchema) {}
class AddLineDto extends createZodDto(addLineSchema) {}

/**
 * Payroll that is calculated: the policy (the rules), the salary structure of each person, and the
 * monthly run with its payslips. What a person may see follows the role: their own payslip only after
 * the run is approved, everyone else's within their team or company.
 */
@ApiTags('payroll')
@ApiBearerAuth()
@Controller()
export class PayrollRunController {
  constructor(
    private readonly policies: PayrollPolicyService,
    private readonly structures: SalaryStructureService,
    private readonly runs: PayrollRunService,
  ) {}

  // ------------------------------------------------------------ policy

  @RequirePermissions('salary.read')
  @Get('payroll/policy')
  policy(@CurrentAuth() auth: AuthContext) {
    return this.policies.current(auth);
  }

  /** Saves the rules from a month onwards. Needs the right to manage payroll. */
  @RequirePermissions('payroll.manage')
  @Put('payroll/policy')
  savePolicy(@CurrentAuth() auth: AuthContext, @Body() body: PolicyDto) {
    return this.policies.save(auth, body);
  }

  // --------------------------------------------------------- structures

  @RequirePermissions('salary.read')
  @Get('salary-structures')
  structureList(@CurrentAuth() auth: AuthContext, @Query() query: StructureQueryDto) {
    return this.structures.list(auth, query);
  }

  @RequirePermissions('salary.read')
  @Get('salary-structures/:userId/history')
  structureHistory(@CurrentAuth() auth: AuthContext, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.structures.history(auth, userId);
  }

  @RequirePermissions('salary.write')
  @Put('salary-structures')
  saveStructure(@CurrentAuth() auth: AuthContext, @Body() body: StructureDto) {
    return this.structures.save(auth, body);
  }

  // --------------------------------------------------------------- runs

  @RequirePermissions('salary.read')
  @Get('payroll/runs')
  list(@CurrentAuth() auth: AuthContext) {
    return this.runs.list(auth);
  }

  @RequirePermissions('payroll.manage')
  @Post('payroll/runs')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateRunDto) {
    return this.runs.create(auth, body.month);
  }

  @RequirePermissions('salary.read')
  @Get('payroll/runs/:id')
  detail(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.detailOf(auth, id);
  }

  @RequirePermissions('payroll.manage')
  @Post('payroll/runs/:id/recalculate')
  @HttpCode(200)
  recalculate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecalculateDto) {
    return this.runs.recalculate(auth, id, body);
  }

  @RequirePermissions('payroll.approve')
  @Post('payroll/runs/:id/approve')
  @HttpCode(200)
  approve(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.approve(auth, id);
  }

  @RequirePermissions('payroll.approve')
  @Post('payroll/runs/:id/reopen')
  @HttpCode(200)
  reopen(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReopenDto) {
    return this.runs.reopen(auth, id, body);
  }

  // ----------------------------------------------------------- payslips

  @RequireAnyPermission('salary.read', 'salary.read_own')
  @Get('payroll/payslips/:id')
  payslip(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.payslip(auth, id);
  }

  /** Adds a line (an extra payment or deduction) to a draft payslip. A reason is required. */
  @RequirePermissions('salary.write')
  @Post('payroll/payslips/:id/lines')
  addLine(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AddLineDto) {
    return this.runs.addLine(auth, id, body);
  }

  /** Changes the amount of a line of a draft payslip. A reason is required. */
  @RequirePermissions('salary.write')
  @Patch('payroll/payslips/:id/lines/:lineId')
  changeLine(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() body: ChangeLineDto,
  ) {
    return this.runs.changeLine(auth, id, lineId, body);
  }

  @RequirePermissions('salary.write')
  @Delete('payroll/payslips/:id/lines/:lineId')
  removeLine(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    return this.runs.removeLine(auth, id, lineId);
  }
}
