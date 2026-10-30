import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { HolidaysService } from './holidays.service.js';
import { LeaveController } from './leave.controller.js';
import { LeaveService } from './leave.service.js';

@Module({
  imports: [AttendanceModule],
  controllers: [LeaveController],
  providers: [LeaveService, HolidaysService],
  exports: [LeaveService],
})
export class LeaveModule {}
