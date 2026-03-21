import 'reflect-metadata';

import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from '../app.module';

export function configureApiApplication(app: INestApplication): void {
  app.enableShutdownHooks();
  app.use('/dashboard', express.static(join(process.cwd(), 'public', 'dashboard')));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('RSS Monitor API')
      .setDescription('HTTP API for managing feeds, rules, entries, alerts, and operational health for the RSS monitor MVP.')
      .setVersion('0.1.0')
      .addTag('Feeds', 'Feed registration and lifecycle management.')
      .addTag('Rules', 'Keyword rule management.')
      .addTag('Entries', 'Persisted entry inspection APIs.')
      .addTag('Alerts', 'Alert inspection and manual delivery APIs.')
      .addTag('Dashboard', 'Operator dashboard mounted from the API origin.')
      .addTag('Observability', 'Health, readiness, and metrics endpoints.')
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/docs-json',
    swaggerOptions: {
      displayRequestDuration: true,
      persistAuthorization: false,
    },
  });
}

export async function createApiApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApiApplication(app);
  return app;
}
