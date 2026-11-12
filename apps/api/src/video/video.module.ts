import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { GuestVideoController, VideoController } from './video.controller.js';
import { VideoAccessService } from './video-access.service.js';
import { VideoService } from './video.service.js';
import { VideoStore } from './video-store.js';
import { VideoSweepService } from './video-sweep.service.js';

@Module({
  imports: [LeadsModule, NotificationsModule],
  controllers: [VideoController, GuestVideoController],
  providers: [VideoStore, VideoService, VideoAccessService, VideoSweepService],
  exports: [VideoSweepService],
})
export class VideoModule {}
