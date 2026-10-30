import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';

@Module({ imports: [IntakeModule], controllers: [IntegrationsController], providers: [IntegrationsService] })
export class IntegrationsModule {}
