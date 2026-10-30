import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { DocumentLimitsController, DocumentsController, FilesController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({ imports: [LeadsModule], controllers: [DocumentsController, DocumentLimitsController, FilesController], providers: [DocumentsService] })
export class DocumentsModule {}
