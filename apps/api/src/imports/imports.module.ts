import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({ imports: [LeadsModule, IntakeModule], controllers: [ImportsController], providers: [ImportsService], exports: [ImportsService] })
export class ImportsModule {}
