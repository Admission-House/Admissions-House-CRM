import { Global, Module } from '@nestjs/common';
import { loadEnv } from './env.js';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
