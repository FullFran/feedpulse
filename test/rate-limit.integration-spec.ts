process.env.NODE_ENV = 'test';
process.env.PORT = '3009';
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

/**
 * The tiny budgets this suite runs on.
 *
 * They MUST be assigned here, above the imports, rather than in `beforeAll`:
 * `AppModule` calls `ConfigModule.forRoot()` while its decorator is evaluated,
 * i.e. the moment `../src/app.module` is required below — long before any hook
 * runs. The typed `AppConfigService` getters therefore freeze whatever
 * `process.env` held at import time, and a later assignment is invisible to
 * them. `restoreEnv` in `afterAll` puts the original values back before the
 * next spec file in the (single-process, --runInBand) integration project is
 * loaded, so these budgets cannot leak into another suite.
 */
const TEST_WINDOW_SECONDS = 60;
const TEST_DEFAULT_LIMIT = 5;
const TEST_WRITE_LIMIT = 2;
const TEST_MAX_FEEDS_PER_TENANT = 2;

const RATE_LIMIT_ENV_KEYS = [
  'RATE_LIMIT_TTL_SECONDS',
  'RATE_LIMIT_MAX_REQUESTS',
  'RATE_LIMIT_WRITE_MAX_REQUESTS',
  'MAX_FEEDS_PER_TENANT',
] as const;

const SAVED_RATE_LIMIT_ENV = new Map<string, string | undefined>(
  RATE_LIMIT_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);

process.env.RATE_LIMIT_TTL_SECONDS = String(TEST_WINDOW_SECONDS);
process.env.RATE_LIMIT_MAX_REQUESTS = String(TEST_DEFAULT_LIMIT);
process.env.RATE_LIMIT_WRITE_MAX_REQUESTS = String(TEST_WRITE_LIMIT);
process.env.MAX_FEEDS_PER_TENANT = String(TEST_MAX_FEEDS_PER_TENANT);

import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { configureApiApplication } from '../src/main/create-api-app';
import {
  DEFAULT_MAX_FEEDS_PER_TENANT,
  resolveMaxFeedsPerTenant,
} from '../src/modules/feeds/application/register-feed.use-case';
import {
  createRateLimitStore,
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_TTL_SECONDS,
  DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS,
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RedisRateLimitStore,
  resolveRateLimitOptions,
} from '../src/shared/http/throttler.module';
import { insertFeed, issueApiKey } from './support/builders';
import { createFakeQueues, overrideQueueProviders } from './support/fakes';
import type { PgMemPool } from './support/pg-mem';
import { createPgMemPoolWithSchema } from './support/schema';

/** One issued credential per tenant; each case uses its own tenant. */
const ISSUED_API_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['ak_rl_default', 'fp_rldeflt1_rate-limit-secret-a'],
  ['ak_rl_other', 'fp_rlother1_rate-limit-secret-b'],
  ['ak_rl_write', 'fp_rlwrite1_rate-limit-secret-c'],
  ['ak_rl_headers', 'fp_rlheadr1_rate-limit-secret-d'],
  ['ak_rl_quota', 'fp_rlquota1_rate-limit-secret-e'],
] as const;

function keyFor(tenantId: string): string {
  const issued = ISSUED_API_KEYS.find(([tenant]) => tenant === tenantId);
  if (!issued) {
    throw new Error(`No API key issued for tenant ${tenantId}`);
  }

  return issued[1];
}

/** `supertest` types both `body` and `headers` as `any`; narrow once, here. */
function jsonBody(response: request.Response): Record<string, unknown> {
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null) {
    throw new Error('expected_json_object_body');
  }

  return body as Record<string, unknown>;
}

function headerOf(response: request.Response, name: string): string | undefined {
  const headers: unknown = response.headers;
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }

  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function saveEnv(keys: readonly string[]): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }

  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('inbound rate limiting', () => {
  let app: INestApplication;
  let httpServer: Server;
  let pool: PgMemPool;
  let store: MemoryRateLimitStore;

  beforeAll(async () => {
    ({ pool } = await createPgMemPoolWithSchema());

    for (const [tenantId, plaintextKey] of ISSUED_API_KEYS) {
      await issueApiKey(pool, { tenantId, plaintextKey });
    }

    const moduleRef = await overrideQueueProviders(
      // `AppModule` imports `RateLimitModule` itself. Importing it a second time
      // here would let the suite pass even if that wiring were removed, and it
      // would change the module-scan order the guard ordering depends on — the
      // "independent tenant budget" case only proves anything if RateLimitGuard
      // reaches the request AFTER AuthGuard has populated `request.tenantId`,
      // which is a property of how AppModule imports the module.
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      createFakeQueues(),
    ).compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;

    // The suite runs against the in-process fallback because the Redis double
    // cannot evaluate Lua. Asserting it makes that an explicit property of the
    // test rather than an accident, and pins the degradation path.
    const resolved = moduleRef.get<MemoryRateLimitStore>(RATE_LIMIT_STORE);
    expect(resolved).toBeInstanceOf(MemoryRateLimitStore);
    store = resolved;
  });

  afterAll(async () => {
    await app.close();
    restoreEnv(SAVED_RATE_LIMIT_ENV);
  });

  beforeEach(() => {
    store.reset();
  });

  it('answers with the standard JSON error envelope once the default budget is exhausted', async () => {
    const apiKey = keyFor('ak_rl_default');

    for (let attempt = 0; attempt < TEST_DEFAULT_LIMIT; attempt += 1) {
      await request(httpServer).get('/api/v1/entries').set('x-api-key', apiKey).expect(200);
    }

    const blocked = await request(httpServer).get('/api/v1/entries').set('x-api-key', apiKey).expect(429);
    const body = jsonBody(blocked);

    expect(headerOf(blocked, 'content-type')).toContain('application/json');
    expect(headerOf(blocked, 'retry-after')).toBe(String(TEST_WINDOW_SECONDS));
    expect(body).toMatchObject({ statusCode: 429, code: 'rate_limit_exceeded', path: '/api/v1/entries' });
    expect(typeof body.message).toBe('string');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.requestId).toBe('string');
    // A rejection must never be rendered by Express' HTML error page.
    expect(blocked.text).not.toContain('<html');
  });

  it('gives each tenant an independent budget', async () => {
    const exhausted = keyFor('ak_rl_default');
    const untouched = keyFor('ak_rl_other');

    for (let attempt = 0; attempt < TEST_DEFAULT_LIMIT; attempt += 1) {
      await request(httpServer).get('/api/v1/entries').set('x-api-key', exhausted).expect(200);
    }

    await request(httpServer).get('/api/v1/entries').set('x-api-key', exhausted).expect(429);
    await request(httpServer).get('/api/v1/entries').set('x-api-key', untouched).expect(200);
  });

  it('bills check-now against the tighter write budget and leaves the read budget alone', async () => {
    const tenantId = 'ak_rl_write';
    const apiKey = keyFor(tenantId);
    const feedId = await insertFeed(pool, { tenantId, url: 'https://feeds.example.com/write-budget.xml' });

    for (let attempt = 0; attempt < TEST_WRITE_LIMIT; attempt += 1) {
      await request(httpServer).post(`/api/v1/feeds/${feedId}/check-now`).set('x-api-key', apiKey).expect(202);
    }

    const blocked = await request(httpServer)
      .post(`/api/v1/feeds/${feedId}/check-now`)
      .set('x-api-key', apiKey)
      .expect(429);
    expect(jsonBody(blocked).code).toBe('rate_limit_exceeded');
    expect(headerOf(blocked, 'x-ratelimit-limit')).toBe(String(TEST_WRITE_LIMIT));

    // The write budget is its own bucket, so reads are still served.
    const read = await request(httpServer).get('/api/v1/entries').set('x-api-key', apiKey).expect(200);
    expect(headerOf(read, 'x-ratelimit-limit')).toBe(String(TEST_DEFAULT_LIMIT));
  });

  it('publishes the remaining budget on allowed responses', async () => {
    const apiKey = keyFor('ak_rl_headers');

    const first = await request(httpServer).get('/api/v1/entries').set('x-api-key', apiKey).expect(200);
    expect(headerOf(first, 'x-ratelimit-limit')).toBe(String(TEST_DEFAULT_LIMIT));
    expect(headerOf(first, 'x-ratelimit-remaining')).toBe(String(TEST_DEFAULT_LIMIT - 1));
    expect(Number(headerOf(first, 'x-ratelimit-reset'))).toBeGreaterThan(0);
    expect(headerOf(first, 'retry-after')).toBeUndefined();

    const second = await request(httpServer).get('/api/v1/entries').set('x-api-key', apiKey).expect(200);
    expect(headerOf(second, 'x-ratelimit-remaining')).toBe(String(TEST_DEFAULT_LIMIT - 2));
  });

  it('never rate limits the monitoring endpoints', async () => {
    for (let attempt = 0; attempt < TEST_DEFAULT_LIMIT + 3; attempt += 1) {
      const response = await request(httpServer).get('/health').expect(200);
      expect(headerOf(response, 'x-ratelimit-limit')).toBeUndefined();
    }
  });

  it('refuses registration past the per-tenant feed cap with feed_limit_reached', async () => {
    const apiKey = keyFor('ak_rl_quota');

    for (let index = 0; index < TEST_MAX_FEEDS_PER_TENANT; index += 1) {
      await request(httpServer)
        .post('/api/v1/feeds')
        .set('x-api-key', apiKey)
        .send({ url: `https://feeds.example.com/quota-${index}.xml` })
        .expect(201);
    }

    const blocked = await request(httpServer)
      .post('/api/v1/feeds')
      .set('x-api-key', apiKey)
      .send({ url: 'https://feeds.example.com/quota-over.xml' })
      .expect(403);

    const body = jsonBody(blocked);
    expect(body).toMatchObject({ statusCode: 403, code: 'feed_limit_reached' });
    expect(String(body.message)).toContain(String(TEST_MAX_FEEDS_PER_TENANT));

    // The cap is per tenant, not global.
    await request(httpServer)
      .post('/api/v1/feeds')
      .set('x-api-key', keyFor('ak_rl_other'))
      .send({ url: 'https://feeds.example.com/other-tenant.xml' })
      .expect(201);
  });
});

describe('resolveRateLimitOptions', () => {
  const keys = ['RATE_LIMIT_TTL_SECONDS', 'RATE_LIMIT_MAX_REQUESTS', 'RATE_LIMIT_WRITE_MAX_REQUESTS'] as const;
  let savedEnv: Map<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(keys);
    for (const key of keys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('falls back to the documented defaults when nothing is configured', () => {
    expect(resolveRateLimitOptions({ nodeEnv: 'test' })).toEqual({
      windowMs: DEFAULT_RATE_LIMIT_TTL_SECONDS * 1000,
      defaultLimit: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      writeLimit: DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS,
    });
  });

  it('prefers the typed configuration over the raw environment', () => {
    process.env.RATE_LIMIT_TTL_SECONDS = '30';
    process.env.RATE_LIMIT_MAX_REQUESTS = '11';
    process.env.RATE_LIMIT_WRITE_MAX_REQUESTS = '3';

    expect(
      resolveRateLimitOptions({
        nodeEnv: 'test',
        rateLimitTtlSeconds: 120,
        rateLimitMaxRequests: 99,
        rateLimitWriteMaxRequests: 7,
      }),
    ).toEqual({ windowMs: 120_000, defaultLimit: 99, writeLimit: 7 });
  });

  it('reads the raw environment while the typed configuration is not wired yet', () => {
    process.env.RATE_LIMIT_TTL_SECONDS = '30';
    process.env.RATE_LIMIT_MAX_REQUESTS = '11';
    process.env.RATE_LIMIT_WRITE_MAX_REQUESTS = '3';

    expect(resolveRateLimitOptions({ nodeEnv: 'test' })).toEqual({
      windowMs: 30_000,
      defaultLimit: 11,
      writeLimit: 3,
    });
  });

  it('treats a zero limit as a disabled bucket but rejects nonsense values', () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = '0';
    process.env.RATE_LIMIT_WRITE_MAX_REQUESTS = 'lots';

    const options = resolveRateLimitOptions({ nodeEnv: 'test' });
    expect(options.defaultLimit).toBe(0);
    expect(options.writeLimit).toBe(DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS);
  });
});

describe('resolveMaxFeedsPerTenant', () => {
  let savedEnv: Map<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv(['MAX_FEEDS_PER_TENANT']);
    delete process.env.MAX_FEEDS_PER_TENANT;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('defaults when neither the configuration nor the environment says anything', () => {
    expect(resolveMaxFeedsPerTenant({ nodeEnv: 'test' })).toBe(DEFAULT_MAX_FEEDS_PER_TENANT);
  });

  it('prefers the typed configuration and accepts 0 as no cap', () => {
    process.env.MAX_FEEDS_PER_TENANT = '25';
    expect(resolveMaxFeedsPerTenant({ nodeEnv: 'test', maxFeedsPerTenant: 3 })).toBe(3);
    expect(resolveMaxFeedsPerTenant({ nodeEnv: 'test', maxFeedsPerTenant: 0 })).toBe(0);
    expect(resolveMaxFeedsPerTenant({ nodeEnv: 'test' })).toBe(25);
  });

  it('ignores a malformed environment value instead of disabling the cap', () => {
    process.env.MAX_FEEDS_PER_TENANT = '-4';
    expect(resolveMaxFeedsPerTenant({ nodeEnv: 'test' })).toBe(DEFAULT_MAX_FEEDS_PER_TENANT);
  });
});

/**
 * Installed at module scope so the spy's type is inferred rather than named:
 * `jest.SpyInstance` does not resolve under this `@types/jest`, and an
 * unresolved annotation turns every call on it into a lint warning.
 */
const loggerWarn = jest.spyOn(Logger.prototype, 'warn');

describe('rate limit stores', () => {
  beforeEach(() => {
    loggerWarn.mockReset();
    loggerWarn.mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarn.mockReset();
  });

  it('counts within a window and starts a fresh one after it expires', async () => {
    const memoryStore = new MemoryRateLimitStore();

    expect(await memoryStore.consume('k', 50)).toMatchObject({ totalHits: 1 });
    expect(await memoryStore.consume('k', 50)).toMatchObject({ totalHits: 2 });
    expect(await memoryStore.consume('other', 50)).toMatchObject({ totalHits: 1 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await memoryStore.consume('k', 50)).toMatchObject({ totalHits: 1 });
  });

  it('uses Redis whenever the injected connection can evaluate Lua, and warns when it cannot', () => {
    expect(createRateLimitStore({ eval: async () => [1, 1000] })).toBeInstanceOf(RedisRateLimitStore);
    expect(loggerWarn).not.toHaveBeenCalled();

    expect(createRateLimitStore({ ping: async () => 'PONG' })).toBeInstanceOf(MemoryRateLimitStore);
    expect(createRateLimitStore(undefined)).toBeInstanceOf(MemoryRateLimitStore);
    expect(loggerWarn).toHaveBeenCalledTimes(2);
  });

  it('reads the Redis reply and survives a PTTL that reports no expiry', async () => {
    const replies: unknown[] = [
      [3, 1500],
      ['4', '-1'],
    ];
    const redisStore = new RedisRateLimitStore({ eval: async () => replies.shift() });

    expect(await redisStore.consume('k', 60_000)).toEqual({ totalHits: 3, resetAfterMs: 1500 });
    expect(await redisStore.consume('k', 60_000)).toEqual({ totalHits: 4, resetAfterMs: 60_000 });
  });

  it('rejects a reply it cannot understand rather than letting traffic through uncounted', async () => {
    const redisStore = new RedisRateLimitStore({ eval: async () => 'OK' });
    await expect(redisStore.consume('k', 1000)).rejects.toThrow('rate_limit_store_unexpected_reply');
  });
});
