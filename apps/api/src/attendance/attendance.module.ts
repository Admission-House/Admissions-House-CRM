import { Module } from '@nestjs/common';
import { AttendanceSummaryService } from './attendance-summary.service.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceRepository } from './attendance.repository.js';
import { AttendanceService } from './attendance.service.js';
import { IdleSweepService } from './idle-sweep.service.js';
import { LocationLogService } from './location-log.service.js';

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceRepository, AttendanceSummaryService, AttendanceService, AttendanceSettingsService, IdleSweepService, LocationLogService],
  // The sign-in code records the check-in; the sweep is exported so it can be run on demand.
  exports: [AttendanceRepository, IdleSweepService, AttendanceSummaryService],
})
export class AttendanceModule {}
