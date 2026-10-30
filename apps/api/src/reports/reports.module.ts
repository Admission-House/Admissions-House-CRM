import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({ imports: [LeadsModule, AttendanceModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
