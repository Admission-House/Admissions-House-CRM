import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { Env } from './config/env.js';

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Keeps a caller's request id only if it looks sane, so log lines cannot be forged. */
export function requestIdFrom(headers: IncomingHttpHeaders): string {
  const incoming = headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Hop 0 is the socket (the nearest proxy). Trusting N proxies means trusting hops 0 to N-1; the
 * address after them is the client. Trusting one hop too many would let a caller choose their own IP.
 */
export function trustProxyFor(hops: number): false | ((address: string, hop: number) => boolean) {
  return hops > 0 ? (_address, hop) => hop < hops : false;
}

export function createAdapter(env: Env): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: trustProxyFor(env.TRUST_PROXY_HOPS),
    bodyLimit: env.BODY_LIMIT_BYTES,
    // Fastify must not read the header itself; genReqId decides whether to keep it.
    requestIdHeader: false,
    genReqId: (req: { headers: IncomingHttpHeaders }) => requestIdFrom(req.headers),
    forceCloseConnections: true,
    // A signed file link is a long path segment (about 300 characters); the default allows 100.
    routerOptions: { maxParamLength: 512 },
  });
}

/** Everything that is configured on the running app. Shared by the real server and the tests. */
export async function configureApp(app: NestFastifyApplication, env: Env): Promise<void> {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  app.getHttpAdapter().getInstance().addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(cookie);
  // One file per request, no larger than the agreed limit; the server stops reading beyond it.
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 8, headerPairs: 40 } });
  await app.register(helmet, { contentSecurityPolicy: !env.ENABLE_API_DOCS });
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  if (env.ENABLE_API_DOCS) {
    const config = new DocumentBuilder()
      .setTitle('Admissions House CRM API')
      .setVersion('1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, config)));
  }
}
