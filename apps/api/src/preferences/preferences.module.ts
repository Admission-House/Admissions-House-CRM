import { Module } from '@nestjs/common';
import { PreferencesController } from './preferences.controller.js';
import { PreferencesService } from './preferences.service.js';

@Module({ controllers: [PreferencesController], providers: [PreferencesService], exports: [PreferencesService] })
export class PreferencesModule {}
