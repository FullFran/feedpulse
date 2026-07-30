process.env.NODE_ENV = 'test';
process.env.PORT = '3005';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.SCHEDULER_TICK_MS = '1000';
process.env.SCHEDULER_BATCH_SIZE = '10';
process.env.WORKER_CONCURRENCY = '1';
process.env.FETCH_TIMEOUT_MS = '1000';
process.env.LOG_LEVEL = 'fatal';
process.env.ENABLE_AUTH = 'true';
process.env.AUTH_PROVIDER = 'api_key';
process.env.TENANT_SECRETS_MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { AlertDeliveryQueue } from '../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../src/infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../src/infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../src/infrastructure/queue/opml-parse-preview.queue';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  FETCH_FEED_QUEUE_TOKEN,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  REDIS_CONNECTION,
} from '../src/infrastructure/queue/queue.constants';
import { configureApiApplication } from '../src/main/create-api-app';
import { AuthGuard } from '../src/shared/auth/auth.guard';
import { HttpAuthService } from '../src/shared/auth/http-auth.service';
import { AllExceptionsFilter } from '../src/shared/filters/all-exceptions.filter';
import { RequestIdInterceptor } from '../src/shared/interceptors/request-id.interceptor';
import { errorBody } from './support/http';

const TEST_TENANT_ID = 'ak_envelope_tenant';

/**
 * Minimal stand-in for the real credential verification: this spec asserts how
 * failures are rendered, not how credentials are checked, and the stub keeps the
 * suite independent of the API key storage schema.
 */
class StubHttpAuthService {
  async authenticateRequest(request: {
    header: (name: string) => string | undefined;
    tenantId?: string;
  }): Promise<void> {
    const apiKey = request.header('x-api-key');
    if (!apiKey) {
      throw new UnauthorizedException('auth_required');
    }

    request.tenantId = TEST_TENANT_ID;
  }
}

class FakeQueue {
  async enqueue(): Promise<void> {}
  createWorker(): never {
    throw new Error('Not used');
  }
}

class FakeRedis {
  async ping(): Promise<string> {
    return 'PONG';
  }
  async quit(): Promise<void> {
    return undefined;
  }
}

async function bootstrapSchema(pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> }): Promise<void> {
  const statements = [
    `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      webhook_notifier_url TEXT,
      recipient_emails TEXT[] NOT NULL DEFAULT '{}',
      telegram_chat_ids TEXT[] NOT NULL DEFAULT '{}',
      telegram_delivery_mode TEXT NOT NULL DEFAULT 'instant',
      telegram_bot_token_ciphertext TEXT,
      telegram_bot_token_iv TEXT,
      telegram_bot_token_tag TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      normalized_url_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      poll_interval_seconds INT NOT NULL DEFAULT 1800,
      error_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}

describe('error envelope integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await bootstrapSchema(pool);

    const fakeQueue = new FakeQueue();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      // Mirrors the global providers AppModule registers in production. Declared
      // here so this spec exercises the guard/filter/interceptor contract even
      // when run in isolation; the wiring itself is asserted separately below.
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
      ],
    })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CONNECTION)
      .useValue(new FakeRedis())
      .overrideProvider(FETCH_FEED_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(FetchFeedQueue)
      .useValue(fakeQueue)
      .overrideProvider(ALERT_DELIVERY_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(AlertDeliveryQueue)
      .useValue(fakeQueue)
      .overrideProvider(OPML_PARSE_PREVIEW_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(OpmlParsePreviewQueue)
      .useValue(fakeQueue)
      .overrideProvider(OPML_APPLY_IMPORT_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(OpmlApplyImportQueue)
      .useValue(fakeQueue)
      .overrideProvider(HttpAuthService)
      .useValue(new StubHttpAuthService())
      .compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers unauthenticated API requests with the JSON error envelope instead of an HTML stack trace', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/feeds').expect(401);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.text).not.toMatch(/<html/i);
    expect(response.body).toMatchObject({
      statusCode: 401,
      code: 'auth_required',
      message: 'auth_required',
      path: '/api/v1/feeds',
    });
    const envelope = errorBody(response);
    expect(typeof envelope.requestId).toBe('string');
    expect(envelope.requestId.length).toBeGreaterThan(0);
    expect(typeof envelope.timestamp).toBe('string');
    // `stack` is deliberately absent from ErrorEnvelope, so this one reads the
    // raw body: a typed accessor could not express "this field must not exist".
    expect(response.body.stack).toBeUndefined();
    expect(response.text).not.toContain('at ');
  });

  it('echoes an inbound x-request-id on the response body and header', async () => {
    const requestId = 'test-request-id-42';

    const response = await request(app.getHttpServer()).get('/api/v1/feeds').set('x-request-id', requestId).expect(401);

    expect(errorBody(response).requestId).toBe(requestId);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('generates a request id when the caller does not provide one', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/feeds').expect(401);

    expect(response.headers['x-request-id']).toBe(errorBody(response).requestId);
  });

  it('surfaces domain error codes such as feed_not_found as a stable machine-readable code', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/feeds/999999')
      .set('x-api-key', 'ak_envelope_tenant')
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      code: 'feed_not_found',
      message: 'feed_not_found',
      path: '/api/v1/feeds/999999',
    });
    expect(response.body.error).toBeUndefined();
  });

  it('reports validation failures with the DTO constraint code', async () => {
    const single = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .set('x-api-key', 'ak_envelope_tenant')
      .send({ url: 'not-a-url' })
      .expect(400);

    // A single failed constraint keeps the snake_case code declared by the DTO.
    const envelope = errorBody(single);
    expect(envelope.statusCode).toBe(400);
    expect(envelope.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(envelope.code).not.toBe('validation_failed');
    expect(envelope.message).toContain(envelope.code);
  });

  it('keeps the dashboard bootstrap endpoint public and unauthenticated routes unguarded', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/dashboard-config').expect(200);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('registers the global guard, filter and interceptor on AppModule', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) ?? []) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const useClassFor = (token: unknown): unknown[] =>
      providers.filter((provider) => provider.provide === token).map((provider) => provider.useClass);

    expect(useClassFor(APP_GUARD)).toContain(AuthGuard);
    expect(useClassFor(APP_FILTER)).toContain(AllExceptionsFilter);
    expect(useClassFor(APP_INTERCEPTOR)).toContain(RequestIdInterceptor);
  });
});

interface CapturedResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function createHost(exceptionRequest: { method: string; url: string; headers?: Record<string, string> }): {
  host: ArgumentsHost;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = { statusCode: 0, body: undefined, headers: {} };

  const response = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return response;
    },
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
      return response;
    },
  };

  const request = { ...exceptionRequest, headers: exceptionRequest.headers ?? {} };

  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('AllExceptionsFilter', () => {
  it('never leaks internal class names or stack traces for unexpected failures', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({ method: 'GET', url: '/api/v1/feeds' });

    class TenantSecretsDecryptError extends Error {}
    filter.catch(new TenantSecretsDecryptError('master key ABC123 is invalid'), host);

    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toMatchObject({
      statusCode: 500,
      code: 'internal_server_error',
      message: 'Internal server error',
    });

    const serialized = JSON.stringify(captured.body);
    expect(serialized).not.toContain('TenantSecretsDecryptError');
    expect(serialized).not.toContain('ABC123');
    expect(serialized).not.toContain('stack');
  });

  it('keeps custom exception payloads such as the readiness report untouched', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({ method: 'GET', url: '/ready' });

    filter.catch(
      new ServiceUnavailableException({ status: 'error', checks: { postgres: 'error', redis: 'ok' } }),
      host,
    );

    expect(captured.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(captured.body).toEqual({ status: 'error', checks: { postgres: 'error', redis: 'ok' } });
  });

  it('falls back to validation_failed when several constraints fail at once', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({ method: 'POST', url: '/api/v1/feeds' });

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['feed_invalid_url', 'feed_invalid_poll_interval'],
      }),
      host,
    );

    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body).toMatchObject({
      code: 'validation_failed',
      message: 'feed_invalid_url; feed_invalid_poll_interval',
    });
  });

  it('renders an oversized request body as 413 payload_too_large instead of a generic 500', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({ method: 'POST', url: '/api/v1/feeds' });

    // Shape of the error `body-parser` raises once express.json's `limit` is exceeded.
    const payloadTooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

    filter.catch(payloadTooLarge, host);

    expect(captured.statusCode).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(captured.body).toMatchObject({
      statusCode: 413,
      code: 'payload_too_large',
      message: 'request entity too large',
    });
  });

  it('keeps flattening non-exposed runtime failures to 500 even when they carry a status', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({ method: 'GET', url: '/api/v1/feeds' });

    // `expose` is absent, so this is an internal failure that merely happens to
    // carry a status field; it must never reach the caller.
    const internal = Object.assign(new Error('connection terminated: password=hunter2'), { status: 503 });

    filter.catch(internal, host);

    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(captured.body).toMatchObject({ code: 'internal_server_error', message: 'Internal server error' });
    expect(JSON.stringify(captured.body)).not.toContain('hunter2');
  });

  it('always sets the correlation header on error responses', () => {
    const filter = new AllExceptionsFilter();
    const { host, captured } = createHost({
      method: 'GET',
      url: '/api/v1/feeds/1',
      headers: { 'x-request-id': 'inbound-id' },
    });

    filter.catch(new NotFoundException('feed_not_found'), host);

    expect(captured.headers['x-request-id']).toBe('inbound-id');
    expect(captured.body).toMatchObject({ code: 'feed_not_found', requestId: 'inbound-id' });
  });
});
