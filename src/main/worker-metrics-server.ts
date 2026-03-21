import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { SHARED_METRICS_REGISTRY } from '../modules/observability/metrics-registry';

/**
 * Starts a minimal HTTP server that exposes /metrics for the worker process.
 * The API's /metrics endpoint aggregates both its own registry AND the worker's
 * metrics by fetching from http://worker:<port>/metrics.
 *
 * @param port - The port to listen on for worker metrics
 * @returns The HTTP server instance (for graceful shutdown)
 */
export function startWorkerMetricsServer(port: number): ReturnType<typeof createServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/metrics' || req.url === '/metrics/') {
      res.setHeader('Content-Type', SHARED_METRICS_REGISTRY.contentType);
      try {
        const metrics = await SHARED_METRICS_REGISTRY.metrics();
        res.end(metrics);
      } catch (error) {
        res.statusCode = 500;
        res.end('# Error collecting metrics\n');
      }
      return;
    }

    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', process: 'worker-metrics' }));
      return;
    }

    res.statusCode = 404;
    res.end('Not Found');
  });

  server.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[WorkerMetrics] Listening on 0.0.0.0:${port}`);
  });

  return server;
}
