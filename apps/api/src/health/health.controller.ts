import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { DatabaseService } from '../database/database.service.js';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  /** The process is up. Used by the platform to decide whether to restart it. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** The process can reach its database. Used by the load balancer to decide whether to send traffic. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException('Database is not reachable');
    }
    return { status: 'ok' };
  }
}
