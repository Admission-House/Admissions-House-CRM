import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsService } from './custom-fields.service.js';

@Module({ imports: [LeadsModule], controllers: [CustomFieldsController], providers: [CustomFieldsService] })
export class CustomFieldsModule {}
