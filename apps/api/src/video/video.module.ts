import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AgoraRecordingClient } from '../recording/agora-recording.client.js';
import { RecordingController, RecordingPublicController } from '../recording/recording.controller.js';
import { RecordingService } from '../recording/recording.service.js';
import { RecordingStorage } from '../recording/recording-storage.js';
import { GuestVideoController, VideoController } from './video.controller.js';
import { VideoAccessService } from './video-access.service.js';
import { VideoService } from './video.service.js';
import { VideoStore } from './video-store.js';
import { VideoSweepService } from './video-sweep.service.js';

@Module({
  imports: [LeadsModule, NotificationsModule],
  controllers: [VideoController, GuestVideoController, RecordingController, RecordingPublicController],
  providers: [VideoStore, VideoService, VideoAccessService, VideoSweepService, RecordingService, AgoraRecordingClient, RecordingStorage],
  exports: [VideoSweepService, RecordingService],
})
export class VideoModule {}
