import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { PartnersController } from './partners.controller.js';
import { PartnersService } from './partners.service.js';

@Module({ imports: [AuditModule, LeadsModule], controllers: [PartnersController], providers: [PartnersService] })
export class PartnersModule {}
