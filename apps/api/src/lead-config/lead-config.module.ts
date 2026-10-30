import { Module } from '@nestjs/common';
import { LeadConfigController } from './lead-config.controller.js';
import { LeadConfigService } from './lead-config.service.js';

@Module({ controllers: [LeadConfigController], providers: [LeadConfigService] })
export class LeadConfigModule {}
