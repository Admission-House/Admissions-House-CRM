import { Controller, Get, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import { AppModule } from '../../src/app.module.js';
import { configureApp, createAdapter } from '../../src/app.setup.js';
import { Public, RequirePermissions } from '../../src/auth/decorators.js';
import { ENV } from '../../src/config/config.module.js';
import { Env, loadEnv } from '../../src/config/env.js';

/** Routes that exist only in tests, to exercise the guard and the client address. */
@Controller('test')
class TestRoutesController {
  @Public()
  @Get('ip')
  ip(@Req() req: FastifyRequest): { ip: string } {
    return { ip: req.ip };
  }

  @RequirePermissions('lead.read')
  @Get('leads')
  leads(): { ok: true } {
    return { ok: true };
  }

  @RequirePermissions('user.manage')
  @Get('users')
  users(): { ok: true } {
    return { ok: true };
  }
}

export async function startApp(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<NestFastifyApplication> {
  const env: Env = loadEnv({ ...process.env, ...overrides });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TestRoutesController],
  })
    // The whole app, not just the web server, must see the overridden settings.
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(env));
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
