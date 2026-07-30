import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { WorkerRunner } from '../modules/ingestion/worker.runner';
import { AppConfigService } from '../shared/config/app-config.service';
import { handleBootstrapFailure, installProcessGuards, resolveShutdownTimeoutMs } from './bootstrap-guards';
import { startWorkerMetricsServer } from './worker-metrics-server';

const BOOTSTRAP_CONTEXT = 'WorkerBootstrap';
const METRICS_CONTEXT = 'WorkerMetrics';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const configService = app.get(AppConfigService);
  const workerMetricsPort = configService.workerMetricsPort;

  installProcessGuards(app, {
    context: BOOTSTRAP_CONTEXT,
    shutdownTimeoutMs: resolveShutdownTimeoutMs(configService),
  });

  // Start the worker metrics HTTP server on a separate port.
  // The API aggregates these metrics via /metrics. The bind address flows through
  // AppConfigService so WORKER_METRICS_BIND is validated by the env schema.
  const metricsServer = startWorkerMetricsServer(workerMetricsPort, configService.workerMetricsBind);

  const runner = app.get(WorkerRunner);
  await runner.start();
  new NestLogger(BOOTSTRAP_CONTEXT).log(`Worker started (metrics on port ${workerMetricsPort})`);

  // Graceful shutdown: stop the metrics server when the app shuts down.
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const metricsLogger = new NestLogger(METRICS_CONTEXT);
  for (const signal of signals) {
    process.once(signal, () => {
      metricsServer.close(() => {
        metricsLogger.log('Metrics server stopped');
      });
    });
  }
}

void bootstrap().catch((error: unknown) => {
  handleBootstrapFailure(error, BOOTSTRAP_CONTEXT);
});
