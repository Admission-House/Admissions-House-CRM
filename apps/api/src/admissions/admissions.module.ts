import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { AdmissionsController } from './admissions.controller.js';
import { AdmissionsService } from './admissions.service.js';

@Module({ imports: [LeadsModule], controllers: [AdmissionsController], providers: [AdmissionsService] })
export class AdmissionsModule {}
