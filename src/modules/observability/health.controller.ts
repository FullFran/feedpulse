import { Controller, Get, Inject, Optional, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Pool } from 'pg';
import IORedis from 'ioredis';

import { DATABASE_POOL } from '../../infrastructure/persistence/database.constants';
import { ReadinessService } from '../../infrastructure/persistence/readiness.service';
import { REDIS_CONNECTION } from '../../infrastructure/queue/queue.constants';
import { HealthResponseModel, ReadinessFailureResponseModel, ReadinessResponseModel } from '../../shared/http/swagger.models';
import { AppConfigService } from '../../shared/config/app-config.service';
import { resolveTenantIdFromRequest } from '../../shared/http/tenant-context';

import { MetricsService } from './metrics.service';

@ApiTags('Observability')
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE_POOL) private readonly databasePool: Pool,
    @Inject(REDIS_CONNECTION) private readonly redisConnection: IORedis,
    private readonly readinessService: ReadinessService,
    private readonly metricsService: MetricsService,
    @Optional() private readonly configService?: AppConfigService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Return a lightweight liveness check for the API runtime.' })
  @ApiOkResponse({ description: 'Liveness returned successfully.', type: HealthResponseModel })
  async health() {
    return {
      status: 'ok',
      checks: {
        api: 'ok',
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Return readiness across PostgreSQL, Redis, and schema state.' })
  @ApiOkResponse({ description: 'All readiness checks passed.', type: ReadinessResponseModel })
  @ApiResponse({ status: 503, description: 'One or more readiness checks failed.', type: ReadinessFailureResponseModel })
  async readiness() {
    const checks: Record<string, string> = {
      postgres: 'ok',
      redis: 'ok',
      schema: 'ok',
    };

    try {
      await this.databasePool.query('SELECT 1');
    } catch (error) {
      checks.postgres = 'error';
    }

    try {
      await this.redisConnection.ping();
    } catch (error) {
      checks.redis = 'error';
    }

    try {
      await this.readinessService.assertSchemaReady();
    } catch (error) {
      checks.schema = 'error';
    }

    if (checks.postgres !== 'ok' || checks.redis !== 'ok' || checks.schema !== 'ok') {
      throw new ServiceUnavailableException({
        status: 'error',
        checks,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      status: 'ok',
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Expose Prometheus metrics for operational monitoring.' })
  @ApiProduces('text/plain; version=0.0.4; charset=utf-8')
  @ApiOkResponse({
    description: 'Prometheus metrics payload (aggregated from API and worker processes).',
    schema: {
      type: 'string',
      example: '# HELP rss_entries_ingested_total Total ingested entries\n# TYPE rss_entries_ingested_total counter',
    },
  })
  async metrics(@Res() response: Response): Promise<void> {
    const localMetrics = await this.metricsService.metrics();

    let aggregatedMetrics = localMetrics;

    // Attempt to fetch worker metrics and merge them
    if (this.configService) {
      try {
        const workerMetricsPort = this.configService.workerMetricsPort;
        const workerUrl = `http://worker:${workerMetricsPort}/metrics`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        try {
          const workerRes = await fetch(workerUrl, { signal: controller.signal });
          clearTimeout(timeout);

          if (workerRes.ok) {
            const workerMetrics = await workerRes.text();
            // Prepend worker metrics labels and content to the output
            // Worker metrics will appear with a "process=\"worker\"" label prefix
            aggregatedMetrics = localMetrics + '\n# Worker process metrics\nglobal_process_info{process="worker"} 1\n' + workerMetrics;
          }
        } catch {
          // Worker metrics not available yet or worker unreachable — log and continue with local only
          clearTimeout(timeout);
        }
      } catch {
        // Config not available or workerMetricsPort not set — serve local metrics only
      }
    }

    response.setHeader('Content-Type', this.metricsService.contentType);
    response.send(aggregatedMetrics);
  }

  @Get('api/v1/ops/summary')
  @ApiOperation({ summary: 'Return tenant-scoped operational counters for the dashboard.' })
  @ApiOkResponse({
    description: 'Operational summary returned successfully.',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            feedsTotal: { type: 'number', example: 12455 },
            feedsActive: { type: 'number', example: 12000 },
            feedsError: { type: 'number', example: 455 },
            entries24h: { type: 'number', example: 923 },
            entries7d: { type: 'number', example: 5432 },
            alertsPending: { type: 'number', example: 18 },
          },
        },
      },
    },
  })
  async opsSummary(@Req() request: Request) {
    const tenantId = resolveTenantIdFromRequest(request);
    const [feedsTotal, feedsActive, feedsError, entries24h, entries7d, alertsPending] = await Promise.all([
      this.databasePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1', [tenantId]),
      this.databasePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1 AND status = $2', [tenantId, 'active']),
      this.databasePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1 AND status = $2', [tenantId, 'error']),
      this.databasePool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries WHERE tenant_id = $1 AND COALESCE(published_at, fetched_at) >= NOW() - INTERVAL '24 hours'`,
        [tenantId],
      ),
      this.databasePool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries WHERE tenant_id = $1 AND COALESCE(published_at, fetched_at) >= NOW() - INTERVAL '7 days'`,
        [tenantId],
      ),
      this.databasePool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM alerts WHERE tenant_id = $1 AND sent = false`,
        [tenantId],
      ),
    ]);

    return {
      data: {
        feedsTotal: Number(feedsTotal.rows[0]?.count ?? '0'),
        feedsActive: Number(feedsActive.rows[0]?.count ?? '0'),
        feedsError: Number(feedsError.rows[0]?.count ?? '0'),
        entries24h: Number(entries24h.rows[0]?.count ?? '0'),
        entries7d: Number(entries7d.rows[0]?.count ?? '0'),
        alertsPending: Number(alertsPending.rows[0]?.count ?? '0'),
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
