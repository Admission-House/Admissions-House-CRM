import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DevicesController, OfficeComputersController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController, OfficeComputersController],
  providers: [DevicesService],
})
export class DevicesModule {}
