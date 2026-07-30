import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { SHARED_METRICS_REGISTRY } from '../modules/observability/metrics-registry';

/**
 * Default bind address. Kept at 0.0.0.0 because the API and the worker run as
 * separate containers and the API scrapes the worker over the compose network.
 *
 * SECURITY: this endpoint exposes the full Prometheus registry (including default
 * Node process metrics). Whenever the worker is NOT isolated inside a private
 * network, set WORKER_METRICS_BIND to a private interface (for example 127.0.0.1)
 * and/or set METRICS_AUTH_TOKEN so the endpoint requires a bearer token. The port
 * must never be published to the public internet.
 */
const DEFAULT_BIND_ADDRESS = '0.0.0.0';

export function resolveWorkerMetricsBindAddress(): string {
  const raw = process.env.WORKER_METRICS_BIND;
  if (typeof raw !== 'string') {
    return DEFAULT_BIND_ADDRESS;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_BIND_ADDRESS;
}

function resolveMetricsAuthToken(): string | undefined {
  const raw = process.env.METRICS_AUTH_TOKEN;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }

  const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
  if (token === undefined) {
    return false;
  }

  const provided = Buffer.from(token.trim(), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

/**
 * Starts a minimal HTTP server that exposes /metrics for the worker process.
 * The API's /metrics endpoint aggregates both its own registry AND the worker's
 * metrics by fetching from http://worker:<port>/metrics.
 *
 * @param port - The port to listen on for worker metrics
 * @param bindAddress - Interface to bind to; defaults to WORKER_METRICS_BIND or 0.0.0.0
 * @returns The HTTP server instance (for graceful shutdown)
 */
export function startWorkerMetricsServer(
  port: number,
  bindAddress: string = resolveWorkerMetricsBindAddress(),
): ReturnType<typeof createServer> {
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url === '/metrics' || req.url === '/metrics/') {
      const expectedToken = resolveMetricsAuthToken();
      if (expectedToken && !isAuthorized(req, expectedToken)) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'metrics_unauthorized' }));
        return;
      }

      res.setHeader('Content-Type', SHARED_METRICS_REGISTRY.contentType);
      try {
        const metrics = await SHARED_METRICS_REGISTRY.metrics();
        res.end(metrics);
      } catch {
        res.statusCode = 500;
        res.end('# Error collecting metrics\n');
      }
      return;
    }

    // Liveness stays open: orchestrators must be able to probe it without secrets.
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', process: 'worker-metrics' }));
      return;
    }

    res.statusCode = 404;
    res.end('Not Found');
  };

  // `createServer` expects a void-returning listener. Handing it an `async`
  // function directly turns any rejection into an unhandled rejection, which
  // terminates the worker process on Node >= 15. The handler is wrapped so a
  // rejection closes that one response instead of taking the worker down.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });

  server.listen(port, bindAddress, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`[WorkerMetrics] Listening on ${bindAddress}:${boundPort}`);
  });

  return server;
}
