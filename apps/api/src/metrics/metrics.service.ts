import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { DatabaseService } from '../database/database.service.js';

/**
 * Numbers for a monitoring tool (Prometheus, Grafana Cloud, Datadog and the like) to collect, so
 * someone is told when the API is slow or failing before the counsellors say so.
 *
 * Requests are counted by route pattern (/api/v1/leads/:id), never by the real address, so the
 * number of series stays small and no lead id or phone number can end up in a metric.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly requests: Counter<'method' | 'route' | 'status'>;
  private readonly duration: Histogram<'method' | 'route'>;

  constructor(database: DatabaseService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'ah_' });

    this.requests = new Counter({ name: 'ah_http_requests_total', help: 'Requests answered, by route and status.', labelNames: ['method', 'route', 'status'], registers: [this.registry] });
    this.duration = new Histogram({
      name: 'ah_http_request_duration_seconds',
      help: 'How long requests took, by route.',
      labelNames: ['method', 'route'],
      // The agreed target is 0.5 s at the 95th percentile, so the buckets are close around it.
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    const pool = (name: string, help: string, read: () => number) =>
      new Gauge({ name, help, registers: [this.registry], collect() { this.set(read()); } });
    pool('ah_db_pool_connections', 'Database connections open.', () => database.poolStats().total);
    pool('ah_db_pool_idle', 'Database connections waiting for work.', () => database.poolStats().idle);
    pool('ah_db_pool_waiting', 'Requests waiting for a free database connection. Above zero for long means the pool is too small or queries are slow.', () => database.poolStats().waiting);
  }

  /** Records one finished request. */
  observe(method: string, route: string, status: number, seconds: number): void {
    this.requests.inc({ method, route, status: String(status) });
    this.duration.observe({ method, route }, seconds);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
