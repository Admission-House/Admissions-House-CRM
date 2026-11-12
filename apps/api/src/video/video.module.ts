import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { GuestVideoController, VideoController } from './video.controller.js';
import { VideoService } from './video.service.js';

@Module({
  imports: [LeadsModule],
  controllers: [VideoController, GuestVideoController],
  providers: [VideoService],
})
export class VideoModule {}
