import { Global, Module } from '@nestjs/common';
import { JobRegistry } from './job-registry.service.js';
import { JobsController } from './jobs.controller.js';

/** Background work: one registry for every job, and the address a scheduler calls on Vercel. Global so any module can register a job. */
@Global()
@Module({ controllers: [JobsController], providers: [JobRegistry], exports: [JobRegistry] })
export class JobsModule {}
