import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({ imports: [AuthModule], controllers: [DevicesController], providers: [DevicesService] })
export class DevicesModule {}
