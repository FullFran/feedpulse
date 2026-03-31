import 'reflect-metadata';

import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from '../app.module';
import { HttpAuthService } from '../shared/auth/http-auth.service';

export function configureApiApplication(app: INestApplication): void {
  const httpAuthService = app.get(HttpAuthService);

  app.use(async (request: Request, _response: Response, next: NextFunction) => {
    const path = request.path ?? '';
    const isApiRoute = path.startsWith('/api/');
    const isPublicApiRoute = path === '/api/v1/auth/dashboard-config';

    if (!isApiRoute || isPublicApiRoute) {
      next();
      return;
    }

    try {
      await httpAuthService.authenticateRequest(request);
      next();
    } catch (error) {
      next(error);
    }
  });

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
      .addTag('Settings', 'Tenant-scoped runtime settings and integrations.')
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
