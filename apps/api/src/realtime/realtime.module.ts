import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LiveBus } from './live-bus.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { PulseController } from './pulse.controller.js';
import { RealtimeListener } from './realtime.listener.js';

@Global()
@Module({ imports: [AuthModule], controllers: [PulseController], providers: [LiveBus, RealtimeGateway, RealtimeListener], exports: [LiveBus] })
export class RealtimeModule {}
