import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { SchedulerRunner } from '../modules/ingestion/scheduler.runner';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const runner = app.get(SchedulerRunner);
  await runner.start();
  Logger.log('Scheduler started', 'Bootstrap');
}

void bootstrap();
