import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { FollowUpReminderService } from './followup-reminder.service.js';
import { FollowUpsController } from './followups.controller.js';
import { FollowUpsService } from './followups.service.js';

@Module({
  imports: [LeadsModule],
  controllers: [FollowUpsController],
  providers: [FollowUpsService, FollowUpReminderService],
  exports: [FollowUpReminderService],
})
export class FollowUpsModule {}
