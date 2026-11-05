import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollFactsService } from './payroll-facts.service.js';
import { PayrollPolicyService } from './payroll-policy.service.js';
import { PayrollRunController } from './payroll-run.controller.js';
import { PayrollRunService } from './payroll-run.service.js';
import { PayrollService } from './payroll.service.js';
import { SalaryStructureService } from './salary-structure.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [PayrollController, PayrollRunController],
  providers: [PayrollService, PayrollPolicyService, SalaryStructureService, PayrollFactsService, PayrollRunService],
  exports: [PayrollService],
})
export class PayrollModule {}
