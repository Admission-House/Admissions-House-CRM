import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LiveBus } from './live-bus.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeListener } from './realtime.listener.js';

@Global()
@Module({ imports: [AuthModule], providers: [LiveBus, RealtimeGateway, RealtimeListener], exports: [LiveBus] })
export class RealtimeModule {}
