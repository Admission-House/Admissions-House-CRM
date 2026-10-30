import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { IntakeController } from './intake.controller.js';
import { IntakeRetryService } from './intake-retry.service.js';
import { IntakeService } from './intake.service.js';
import { LeadIngestService } from './lead-ingest.service.js';

@Module({
  imports: [LeadsModule],
  controllers: [IntakeController],
  providers: [ApiKeyGuard, LeadIngestService, IntakeService, IntakeRetryService],
  // Leads created by hand or imported will go through the same ingest service.
  exports: [IntakeService, LeadIngestService],
})
export class IntakeModule {}
