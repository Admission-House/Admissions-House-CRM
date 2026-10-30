import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { IntakeService } from './intake.service.js';

/** Runs the intake retry on a timer, so a lead that failed to file is not left waiting for a person. */
@Injectable()
export class IntakeRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntakeRetryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly intake: IntakeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.INTAKE_RETRY_INTERVAL_SEC <= 0) return;
    this.timer = setInterval(() => void this.run(), this.env.INTAKE_RETRY_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tried = await this.intake.retryDue();
      if (tried > 0) this.logger.log(`retried ${tried} intake events`);
    } catch (err) {
      this.logger.error(`intake retry failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
