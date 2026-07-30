import {
  Controller,
  Get,
  Inject,
  Optional,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import IORedis from 'ioredis';
import { timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { Counter, Gauge } from 'prom-client';
import { DATABASE_POOL } from '../../infrastructure/persistence/database.constants';
import { ReadinessService } from '../../infrastructure/persistence/readiness.service';
import { REDIS_CONNECTION } from '../../infrastructure/queue/queue.constants';
import { AppConfigService } from '../../shared/config/app-config.service';
import {
  HealthResponseModel,
  ReadinessFailureResponseModel,
  ReadinessResponseModel,
} from '../../shared/http/swagger.models';
import { resolveTenantIdFromRequest } from '../../shared/http/tenant-context';
import { SHARED_METRICS_REGISTRY } from './metrics-registry';
import { MetricsService } from './metrics.service';

const WORKER_METRICS_TIMEOUT_MS = 2000;

/**
 * Reads the optional metrics bearer token from the environment on every call so
 * that operators can rotate it without a rebuild and so tests stay deterministic.
 * `/metrics` stays open when the variable is unset, which keeps local development
 * and single-host deployments working exactly as before.
 */
export function resolveMetricsAuthToken(): string | undefined {
  const raw = process.env.METRICS_AUTH_TOKEN;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractBearerToken(request: Pick<Request, 'headers'>): string {
  const header = request.headers?.authorization;
  if (typeof header !== 'string') {
    return '';
  }

  // Parsed by slicing, not by regex. `/^Bearer\s+(.+)$/i` backtracks between
  // `\s+` and `.+` (both match a space), so an attacker-supplied header of
  // "bearer " followed by many spaces costs polynomial time on an endpoint that
  // is reachable before the token is ever checked.
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return '';
  }

  return trimmed.slice('bearer '.length).trim();
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function getOrCreateGauge(name: string, help: string): Gauge {
  const existing = SHARED_METRICS_REGISTRY.getSingleMetric(name);
  if (existing) {
    return existing as Gauge;
  }

  return new Gauge({ name, help, registers: [SHARED_METRICS_REGISTRY] });
}

function getOrCreateCounter(name: string, help: string): Counter {
  const existing = SHARED_METRICS_REGISTRY.getSingleMetric(name);
  if (existing) {
    return existing as Counter;
  }

  return new Counter({ name, help, registers: [SHARED_METRICS_REGISTRY] });
}

/**
 * 1 when the last worker metrics scrape succeeded, 0 when it failed. Without this
 * the API silently serves API-only metrics and a dead worker looks like a healthy
 * system with no feed activity.
 */
const workerMetricsUpGauge = getOrCreateGauge(
  'feedpulse_worker_metrics_up',
  'Whether the last worker metrics scrape performed by the API succeeded (1) or failed (0)',
);

const workerMetricsScrapeFailuresCounter = getOrCreateCounter(
  'feedpulse_worker_metrics_scrape_failures_total',
  'Total failed worker metrics scrapes performed by the API /metrics aggregator',
);

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
  // Liveness answers from process state alone — no I/O, so nothing to await.
  // Nest serializes the returned object exactly as it would a resolved Promise.
  health() {
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
  @ApiResponse({
    status: 503,
    description: 'One or more readiness checks failed.',
    type: ReadinessFailureResponseModel,
  })
  async readiness() {
    const checks: Record<string, string> = {
      postgres: 'ok',
      redis: 'ok',
      schema: 'ok',
    };

    try {
      await this.databasePool.query('SELECT 1');
    } catch {
      checks.postgres = 'error';
    }

    try {
      await this.redisConnection.ping();
    } catch {
      checks.redis = 'error';
    }

    try {
      await this.readinessService.assertSchemaReady();
    } catch {
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
  @ApiOperation({
    summary: 'Expose Prometheus metrics for operational monitoring.',
    description:
      'Requires an `Authorization: Bearer <METRICS_AUTH_TOKEN>` header when `METRICS_AUTH_TOKEN` is configured. Left open when the variable is unset so that local development and private-network scrapers keep working.',
  })
  @ApiProduces('text/plain; version=0.0.4; charset=utf-8')
  @ApiOkResponse({
    description: 'Prometheus metrics payload (aggregated from API and worker processes).',
    schema: {
      type: 'string',
      example: '# HELP rss_entries_ingested_total Total ingested entries\n# TYPE rss_entries_ingested_total counter',
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid metrics bearer token.' })
  async metrics(@Req() request: Request, @Res() response: Response): Promise<void> {
    const expectedToken = resolveMetricsAuthToken();
    if (expectedToken) {
      const providedToken = extractBearerToken(request);
      if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
        throw new UnauthorizedException('metrics_unauthorized');
      }
    }

    // Scrape the worker before rendering the local registry so that the scrape
    // outcome is part of the very payload the caller receives.
    const workerMetrics = await this.scrapeWorkerMetrics(expectedToken);
    const localMetrics = await this.metricsService.metrics();

    const aggregatedMetrics =
      workerMetrics === null
        ? localMetrics
        : `${localMetrics}\n# Worker process metrics\nglobal_process_info{process="worker"} 1\n${workerMetrics}`;

    response.setHeader('Content-Type', this.metricsService.contentType);
    response.send(aggregatedMetrics);
  }

  /**
   * Fetches the worker registry over the internal network. Returns `null` when the
   * worker is unreachable, and records that outcome on the shared registry so a dead
   * worker is visible instead of silently degrading to API-only metrics.
   */
  private async scrapeWorkerMetrics(metricsAuthToken: string | undefined): Promise<string | null> {
    if (!this.configService) {
      // No configuration available (standalone API context): nothing to aggregate.
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WORKER_METRICS_TIMEOUT_MS);

    try {
      const workerUrl = `http://worker:${this.configService.workerMetricsPort}/metrics`;
      const headers: Record<string, string> = {};
      if (metricsAuthToken) {
        headers.Authorization = `Bearer ${metricsAuthToken}`;
      }

      const workerResponse = await fetch(workerUrl, { signal: controller.signal, headers });
      if (!workerResponse.ok) {
        throw new Error(`worker_metrics_http_${workerResponse.status}`);
      }

      const body = await workerResponse.text();
      workerMetricsUpGauge.set(1);
      return body;
    } catch {
      workerMetricsUpGauge.set(0);
      workerMetricsScrapeFailuresCounter.inc();
      return null;
    } finally {
      clearTimeout(timeout);
    }
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
      this.databasePool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1', [
        tenantId,
      ]),
      this.databasePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1 AND status = $2',
        [tenantId, 'active'],
      ),
      this.databasePool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM feeds WHERE tenant_id = $1 AND status = $2',
        [tenantId, 'error'],
      ),
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
