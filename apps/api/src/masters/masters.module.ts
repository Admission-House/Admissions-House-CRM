import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { CollegeApiController } from './college-api.controller.js';
import { CollegeApiService } from './college-api.service.js';
import { MasterImportController } from './master-import.controller.js';
import { MasterImportService } from './master-import.service.js';
import { MastersController } from './masters.controller.js';
import { MastersService } from './masters.service.js';

@Module({
  imports: [LeadsModule],
  controllers: [MastersController, MasterImportController, CollegeApiController],
  providers: [MastersService, MasterImportService, CollegeApiService],
  exports: [MastersService],
})
export class MastersModule {}
