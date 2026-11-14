import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module.js';
import { configureApp, createAdapter } from './app.setup.js';
import { loadEnv } from './config/env.js';

/**
 * The API as a function, for a place that has no long-running server (Vercel). The app is started once and kept for as
 * long as the instance lives, so most requests find it ready; each request is then handed to the same Fastify server a
 * normal start would have used. Nothing listens on a port, and nothing here is specific to one hosting company.
 */
let ready: Promise<NestFastifyApplication> | undefined;

async function boot(): Promise<NestFastifyApplication> {
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(env), {
    bufferLogs: true,
    // Agora signs the exact bytes of each notice, so the server keeps them to check the signature.
    rawBody: true,
  });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A start that failed is tried again by the next request, instead of failing for ever.
  ready ??= boot().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  const app = await ready;
  app.getHttpAdapter().getHttpServer().emit('request', req, res);
}
