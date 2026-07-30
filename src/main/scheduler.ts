import 'reflect-metadata';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from '../app.module';
import { SchedulerRunner } from '../modules/ingestion/scheduler.runner';
import { AppConfigService } from '../shared/config/app-config.service';
import { handleBootstrapFailure, installProcessGuards, resolveShutdownTimeoutMs } from './bootstrap-guards';

const BOOTSTRAP_CONTEXT = 'SchedulerBootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  installProcessGuards(app, {
    context: BOOTSTRAP_CONTEXT,
    shutdownTimeoutMs: resolveShutdownTimeoutMs(app.get(AppConfigService)),
  });

  const runner = app.get(SchedulerRunner);
  await runner.start();
  new NestLogger(BOOTSTRAP_CONTEXT).log('Scheduler started');
}

void bootstrap().catch((error: unknown) => {
  handleBootstrapFailure(error, BOOTSTRAP_CONTEXT);
});
