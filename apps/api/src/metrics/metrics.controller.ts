import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Headers, Inject, NotFoundException, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/decorators.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { MetricsService } from './metrics.service.js';

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The numbers for a monitoring tool. Off unless METRICS_TOKEN is set; then the tool must send it as
 * a bearer token. It is not behind a person's sign-in because a monitoring tool has none.
 */
@Public()
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  async scrape(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    // Switched off: the address does not exist, so there is nothing to find.
    if (!this.env.METRICS_TOKEN) throw new NotFoundException();
    const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (!given || !same(given, this.env.METRICS_TOKEN)) throw new UnauthorizedException();
    void reply.header('content-type', this.metrics.registry.contentType);
    return this.metrics.render();
  }
}
