import { Global, Module } from '@nestjs/common';
import { DownloadAlerts } from './download-alerts.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, DownloadAlerts],
  exports: [NotificationsService, DownloadAlerts],
})
export class NotificationsModule {}
