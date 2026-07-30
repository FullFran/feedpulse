import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type IORedis from 'ioredis';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { ReadinessService } from '../src/infrastructure/persistence/readiness.service';
import { resolveWorkerMetricsBindAddress, startWorkerMetricsServer } from '../src/main/worker-metrics-server';
import { HealthController } from '../src/modules/observability/health.controller';
import { SHARED_METRICS_REGISTRY } from '../src/modules/observability/metrics-registry';
import type { MetricsService } from '../src/modules/observability/metrics.service';
import type { AppConfigService } from '../src/shared/config/app-config.service';

/** Captured before any test replaces globalThis.fetch with a stub. */
const originalFetchRef = globalThis.fetch;

const LOCAL_METRICS = '# HELP rss_fetch_total Total feed fetch requests\nrss_fetch_total 3\n';
const WORKER_METRICS = '# HELP worker_only_total Worker counter\nworker_only_total 9\n';

function createResponse() {
  const headers: Record<string, string> = {};
  const sent: string[] = [];

  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    send: (body: string) => {
      sent.push(body);
    },
  } as unknown as Response;

  return { response, headers, sent };
}

function createRequest(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request;
}

function createController(): HealthController {
  const metricsService = {
    metrics: async () => LOCAL_METRICS,
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  } as unknown as MetricsService;

  const configService = { workerMetricsPort: 3001 } as unknown as AppConfigService;

  return new HealthController(
    {} as unknown as Pool,
    {} as unknown as IORedis,
    {} as unknown as ReadinessService,
    metricsService,
    configService,
  );
}

function gaugeValue(name: string): number | undefined {
  const metric = SHARED_METRICS_REGISTRY.getSingleMetric(name) as { get: () => Promise<unknown> } | undefined;
  if (!metric) {
    return undefined;
  }

  // prom-client exposes a synchronous internal hashMap for gauges/counters.
  const values = (metric as unknown as { hashMap: Record<string, { value: number }> }).hashMap;
  return values['']?.value;
}

describe('GET /metrics', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('stays open when METRICS_AUTH_TOKEN is unset', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    globalThis.fetch = jest.fn(async () => {
      throw new Error('worker_down');
    });

    const { response, sent, headers } = createResponse();
    await createController().metrics(createRequest(), response);

    expect(sent[0]).toContain('rss_fetch_total 3');
    expect(headers['Content-Type']).toContain('text/plain');
  });

  it('rejects a request without a bearer token when METRICS_AUTH_TOKEN is set', async () => {
    process.env.METRICS_AUTH_TOKEN = 'metrics-secret';
    globalThis.fetch = jest.fn();

    const { response, headers, sent } = createResponse();

    await expect(createController().metrics(createRequest(), response)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(headers['WWW-Authenticate']).toBe('Bearer realm="metrics"');
    expect(sent).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a request carrying the wrong bearer token', async () => {
    process.env.METRICS_AUTH_TOKEN = 'metrics-secret';
    const { response, sent } = createResponse();

    await expect(createController().metrics(createRequest('Bearer wrong-secret'), response)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sent).toHaveLength(0);
  });

  it('serves aggregated metrics and forwards the token to the worker when authorised', async () => {
    process.env.METRICS_AUTH_TOKEN = 'metrics-secret';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => WORKER_METRICS,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { response, sent } = createResponse();
    await createController().metrics(createRequest('Bearer metrics-secret'), response);

    expect(sent[0]).toContain('rss_fetch_total 3');
    expect(sent[0]).toContain('worker_only_total 9');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('http://worker:3001/metrics');
    expect(init.headers.Authorization).toBe('Bearer metrics-secret');
    expect(gaugeValue('feedpulse_worker_metrics_up')).toBe(1);
  });

  it('reports a failed worker scrape instead of silently serving API-only metrics', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    globalThis.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const before = gaugeValue('feedpulse_worker_metrics_scrape_failures_total') ?? 0;

    const { response, sent } = createResponse();
    await createController().metrics(createRequest(), response);

    expect(sent[0]).not.toContain('worker_only_total');
    expect(gaugeValue('feedpulse_worker_metrics_up')).toBe(0);
    expect(gaugeValue('feedpulse_worker_metrics_scrape_failures_total')).toBe(before + 1);
  });

  it('treats a non-2xx worker response as a failed scrape', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;

    const { response, sent } = createResponse();
    await createController().metrics(createRequest(), response);

    expect(sent[0]).not.toContain('unauthorized');
    expect(gaugeValue('feedpulse_worker_metrics_up')).toBe(0);
  });
});

describe('worker metrics server', () => {
  const originalBind = process.env.WORKER_METRICS_BIND;
  let server: ReturnType<typeof startWorkerMetricsServer> | undefined;

  afterEach(async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    if (originalBind === undefined) {
      delete process.env.WORKER_METRICS_BIND;
    } else {
      process.env.WORKER_METRICS_BIND = originalBind;
    }

    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  async function listen(): Promise<string> {
    server = startWorkerMetricsServer(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it('defaults the bind address to 0.0.0.0 and honours WORKER_METRICS_BIND', () => {
    delete process.env.WORKER_METRICS_BIND;
    expect(resolveWorkerMetricsBindAddress()).toBe('0.0.0.0');

    process.env.WORKER_METRICS_BIND = ' 127.0.0.1 ';
    expect(resolveWorkerMetricsBindAddress()).toBe('127.0.0.1');

    process.env.WORKER_METRICS_BIND = '   ';
    expect(resolveWorkerMetricsBindAddress()).toBe('0.0.0.0');
  });

  it('serves metrics without a token when METRICS_AUTH_TOKEN is unset', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const baseUrl = await listen();

    const response = await originalFetchRef(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
  });

  it('requires a bearer token on /metrics but keeps /health open when gated', async () => {
    process.env.METRICS_AUTH_TOKEN = 'worker-secret';
    const baseUrl = await listen();

    const unauthenticated = await originalFetchRef(`${baseUrl}/metrics`);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer realm="metrics"');

    const wrongToken = await originalFetchRef(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer nope' } });
    expect(wrongToken.status).toBe(401);

    const authorized = await originalFetchRef(`${baseUrl}/metrics`, {
      headers: { Authorization: 'Bearer worker-secret' },
    });
    expect(authorized.status).toBe(200);

    const health = await originalFetchRef(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', process: 'worker-metrics' });
  });
});
