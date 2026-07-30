import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import express from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppModule } from '../app.module';
import { AppConfigService } from '../shared/config/app-config.service';

/** Hard cap on request bodies parsed as JSON or url-encoded form data. */
const REQUEST_BODY_LIMIT = '256kb';

/**
 * Wires the HTTP edge of the API runtime.
 *
 * Ordering is load-bearing and runs entirely on the underlying Express instance,
 * before Nest's own pipeline:
 *  1. `helmet` first, so every response — including static assets and Swagger UI —
 *     carries the security headers.
 *  2. The `/docs` CSP relaxation second, because it must overwrite the global
 *     Content-Security-Policy header for those paths only.
 *  3. Body parsers third. Registering `express.json` here (before `app.init()`)
 *     makes Nest's `registerParserMiddleware` skip its own 100kb parser: it detects
 *     a middleware already named `jsonParser`/`urlencodedParser` on the router.
 *  4. CORS last, before the routes are mounted.
 *
 * Authentication is NOT here: it is a global `AuthGuard` registered in `AppModule`,
 * so a rejection is rendered by `AllExceptionsFilter` as JSON instead of by Express'
 * `finalhandler` as an HTML page containing a stack trace.
 */
export function configureApiApplication(app: INestApplication): void {
  const configService = app.get(AppConfigService);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          // public/dashboard/app.js injects Clerk from jsDelivr at runtime
          // (CLERK_SCRIPT_URL), and Clerk then loads its own frontend bundle.
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://*.clerk.accounts.dev', 'https://*.clerk.com'],
          connectSrc: ["'self'", 'https://*.clerk.accounts.dev', 'https://*.clerk.com'],
          workerSrc: ["'self'", 'blob:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Swagger UI ships an inline initializer script; scope the relaxation to /docs
  // instead of disabling CSP globally.
  app.use(
    ['/docs', '/docs-json'],
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    }),
  );

  // Does NOT affect OPML: uploads arrive as multipart/form-data and are capped
  // independently by multer at OPML_UPLOAD_MAX_BYTES.
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  const corsOrigins = configService.corsOrigins;
  app.enableCors({ origin: corsOrigins.length > 0 ? corsOrigins : false, credentials: false });

  app.enableShutdownHooks();
  app.use('/dashboard', express.static(join(process.cwd(), 'public', 'dashboard')));

  if (configService.enableSwagger) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('FeedPulse API')
        .setDescription(
          'HTTP API for registering RSS/Atom feeds and keyword rules, inspecting the entries and alerts they produce, and reading operational health.',
        )
        .setVersion('0.1.0')
        .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'ApiKey')
        .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'Bearer')
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
}

export async function createApiApplication(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApiApplication(app);
  return app;
}
