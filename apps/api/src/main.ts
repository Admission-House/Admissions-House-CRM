import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './app.setup.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(env), {
    bufferLogs: true,
  });
  await configureApp(app, env);
  await app.listen(env.PORT, env.HOST);
  app.get(Logger).log(`Admissions House CRM API listening on ${env.HOST}:${env.PORT}`);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
