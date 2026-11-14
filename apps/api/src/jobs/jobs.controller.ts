import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators.js';
import { AppError } from '../common/app-error.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { JOB_GROUPS, JobGroup, JobOutcome, JobRegistry } from './job-registry.service.js';

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Where a scheduler (Vercel Cron) asks for background work to be done. Anyone can reach the address, so
 * it does nothing unless the request carries the secret in CRON_SECRET (Vercel sends it as a Bearer token).
 * Without the secret set, or when the API runs as a server with its own timers, it is switched off.
 */
@ApiExcludeController()
@Public()
@Controller('internal/jobs')
export class JobsController {
  constructor(
    private readonly jobs: JobRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get(':group')
  async run(@Param('group') group: string, @Headers('authorization') authorization: string | undefined): Promise<{ group: JobGroup; results: JobOutcome[] }> {
    const secret = this.env.CRON_SECRET;
    if (this.env.JOBS_MODE !== 'cron' || !secret) throw AppError.notFound();
    const given = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1] ?? '';
    if (!same(given, secret)) throw AppError.unauthorized('Not allowed');
    if (!(JOB_GROUPS as readonly string[]).includes(group)) throw AppError.notFound();
    return { group: group as JobGroup, results: await this.jobs.runGroup(group as JobGroup) };
  }
}
