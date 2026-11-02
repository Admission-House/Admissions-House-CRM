import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PushDispatchService } from './push-dispatch.service.js';
import { ExpoPushProvider, NoPushProvider, PushProvider } from './push-provider.js';
import { PushTokensController } from './push-tokens.controller.js';
import { PushTokensService } from './push-tokens.service.js';

@Module({
  controllers: [PushTokensController],
  providers: [
    { provide: PushProvider, inject: [ENV], useFactory: (env: Env): PushProvider => (env.PUSH_PROVIDER === 'off' ? new NoPushProvider() : new ExpoPushProvider(env.EXPO_ACCESS_TOKEN)) },
    PushTokensService,
    PushDispatchService,
  ],
  exports: [PushDispatchService],
})
export class PushModule {}
