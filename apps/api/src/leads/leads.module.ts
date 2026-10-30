import { Module } from '@nestjs/common';
import { AssignmentService } from '../intake/assignment.service.js';
import { FollowUpWriter } from './followup-writer.js';
import { Assignees } from './assignees.js';
import { LeadAccess } from './lead-access.js';
import { LeadStatusesController } from './lead-statuses.controller.js';
import { LeadStatusesService } from './lead-statuses.service.js';
import { LeadWriter } from './lead-writer.js';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';
import { ProfileController, SuggestionsController } from './profile.controller.js';
import { ProfileService } from './profile.service.js';

@Module({
  controllers: [LeadsController, LeadStatusesController, ProfileController, SuggestionsController],
  providers: [LeadWriter, FollowUpWriter, LeadAccess, Assignees, AssignmentService, LeadsService, LeadStatusesService, ProfileService],
  exports: [LeadsService, LeadWriter, FollowUpWriter, LeadAccess, Assignees, AssignmentService],
})
export class LeadsModule {}
