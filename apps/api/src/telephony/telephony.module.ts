import { Module } from '@nestjs/common';
import { IntakeModule } from '../intake/intake.module.js';
import { LeadsModule } from '../leads/leads.module.js';
import { RecordingFetcher } from './recording-fetcher.service.js';
import { DialerController } from './dialer.controller.js';
import { DialerService } from './dialer.service.js';
import { CallsController } from './calls.controller.js';
import { CallsService } from './calls.service.js';
import { CallEventsService } from './call-events.service.js';
import { GenericProvider } from './providers/generic.provider.js';
import { TELEPHONY_PROVIDERS } from './providers/provider.js';
import { ProviderRegistry } from './providers/registry.js';
import { TelephonyKeyGuard } from './telephony-key.guard.js';
import { TelephonySettingsController } from './telephony-settings.controller.js';
import { TelephonySettingsService } from './telephony-settings.service.js';
import { TelephonyWebhookController } from './telephony-webhook.controller.js';
import { TelephonyWebhookService } from './telephony-webhook.service.js';

@Module({
  imports: [LeadsModule, IntakeModule],
  controllers: [TelephonyWebhookController, TelephonySettingsController, CallsController, DialerController],
  providers: [
    GenericProvider,
    // To add a provider: write its adapter and list it here.
    { provide: TELEPHONY_PROVIDERS, useFactory: (generic: GenericProvider) => [generic], inject: [GenericProvider] },
    ProviderRegistry,
    TelephonyKeyGuard,
    TelephonySettingsService,
    TelephonyWebhookService,
    CallEventsService,
    CallsService,
    RecordingFetcher,
    DialerService,
  ],
  exports: [ProviderRegistry, TelephonySettingsService, CallEventsService, RecordingFetcher],
})
export class TelephonyModule {}
