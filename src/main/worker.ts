import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppConfigService } from '../shared/config/app-config.service';
import { AppModule } from '../app.module';
import { WorkerRunner } from '../modules/ingestion/worker.runner';
import { startWorkerMetricsServer } from './worker-metrics-server';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const configService = app.get(AppConfigService);
  const workerMetricsPort = configService.workerMetricsPort;

  // Start the worker metrics HTTP server on a separate port
  // The API will aggregate these metrics via /metrics
  const metricsServer = startWorkerMetricsServer(workerMetricsPort);

  const runner = app.get(WorkerRunner);
  await runner.start();
  Logger.log(`Worker started (metrics on port ${workerMetricsPort})`, 'Bootstrap');

  // Graceful shutdown: stop the metrics server when the app shuts down
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      metricsServer.close(() => {
        // eslint-disable-next-line no-console
        console.log(`[WorkerMetrics] Server stopped`);
      });
    });
  }
}

void bootstrap();
