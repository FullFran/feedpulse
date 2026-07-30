import { configuration } from '../src/shared/config/configuration';
import { validateEnv } from '../src/shared/config/env.schema';

const baseEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:55432/rss_monitor',
  REDIS_URL: 'redis://localhost:56379',
} as const;

describe('validateEnv', () => {
  it('accepts an empty webhook notifier url in local env files', () => {
    const env = validateEnv({
      ...baseEnv,
      WEBHOOK_NOTIFIER_URL: '',
      WEBHOOK_NOTIFIER_TIMEOUT_MS: '5000',
      SCHEDULER_TICK_MS: '15000',
      SCHEDULER_BATCH_SIZE: '100',
      WORKER_CONCURRENCY: '5',
      FETCH_TIMEOUT_MS: '10000',
      LOG_LEVEL: 'info',
    });

    expect(env.WEBHOOK_NOTIFIER_URL).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TENANT_SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.TELEGRAM_API_URL).toBe('https://api.telegram.org');
  });

  describe('runtime lifecycle', () => {
    it('defaults the shutdown deadline to 30 seconds', () => {
      expect(validateEnv(baseEnv).SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    });

    it('coerces an explicit shutdown deadline and rejects a non-positive one', () => {
      expect(validateEnv({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '5000' }).SHUTDOWN_TIMEOUT_MS).toBe(5000);
      expect(() => validateEnv({ ...baseEnv, SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/Invalid environment configuration/);
    });
  });

  describe('scheduler stuck-feed sweep', () => {
    it('defaults the claim threshold to 300 seconds', () => {
      expect(validateEnv(baseEnv).SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS).toBe(300);
    });

    it('rejects a non-positive threshold instead of releasing in-flight feeds', () => {
      expect(() => validateEnv({ ...baseEnv, SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS: '0' })).toThrow(
        /Invalid environment configuration/,
      );
      expect(() => validateEnv({ ...baseEnv, SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS: '-1' })).toThrow(
        /Invalid environment configuration/,
      );
    });
  });

  describe('outbound fetch safety', () => {
    it('keeps private feed hosts blocked by default', () => {
      expect(validateEnv(baseEnv).ALLOW_PRIVATE_FEED_HOSTS).toBe(false);
    });

    it('parses the private-host escape hatch from the usual truthy vocabulary', () => {
      for (const raw of ['true', '1', 'yes', 'on']) {
        expect(validateEnv({ ...baseEnv, ALLOW_PRIVATE_FEED_HOSTS: raw }).ALLOW_PRIVATE_FEED_HOSTS).toBe(true);
      }

      for (const raw of ['false', '0', 'no', 'off']) {
        expect(validateEnv({ ...baseEnv, ALLOW_PRIVATE_FEED_HOSTS: raw }).ALLOW_PRIVATE_FEED_HOSTS).toBe(false);
      }
    });

    it('defaults the feed body cap to 5 MiB and coerces an override', () => {
      expect(validateEnv(baseEnv).FEED_FETCH_MAX_BYTES).toBe(5 * 1024 * 1024);
      expect(validateEnv({ ...baseEnv, FEED_FETCH_MAX_BYTES: '1024' }).FEED_FETCH_MAX_BYTES).toBe(1024);
    });
  });

  describe('observability', () => {
    it('leaves the metrics endpoint open when no bearer token is configured', () => {
      expect(validateEnv(baseEnv).METRICS_AUTH_TOKEN).toBeUndefined();
      expect(validateEnv({ ...baseEnv, METRICS_AUTH_TOKEN: '   ' }).METRICS_AUTH_TOKEN).toBeUndefined();
      expect(validateEnv({ ...baseEnv, METRICS_AUTH_TOKEN: ' scrape-token ' }).METRICS_AUTH_TOKEN).toBe('scrape-token');
    });

    it('binds the worker metrics server to every interface by default', () => {
      expect(validateEnv(baseEnv).WORKER_METRICS_BIND).toBe('0.0.0.0');
      expect(validateEnv({ ...baseEnv, WORKER_METRICS_BIND: ' 127.0.0.1 ' }).WORKER_METRICS_BIND).toBe('127.0.0.1');
    });
  });

  describe('http edge', () => {
    it('leaves CORS unset by default', () => {
      expect(validateEnv(baseEnv).CORS_ORIGINS).toBeUndefined();
      expect(validateEnv({ ...baseEnv, CORS_ORIGINS: '' }).CORS_ORIGINS).toBeUndefined();
    });

    it('leaves the Swagger flag undefined so configuration can derive it from NODE_ENV', () => {
      expect(validateEnv(baseEnv).ENABLE_SWAGGER).toBeUndefined();
      expect(validateEnv({ ...baseEnv, ENABLE_SWAGGER: 'false' }).ENABLE_SWAGGER).toBe(false);
      expect(validateEnv({ ...baseEnv, ENABLE_SWAGGER: 'true' }).ENABLE_SWAGGER).toBe(true);
    });
  });

  describe('auth', () => {
    it('normalises AUTH_PROVIDER case and surrounding whitespace', () => {
      expect(validateEnv(baseEnv).AUTH_PROVIDER).toBe('clerk_api_key');
      expect(validateEnv({ ...baseEnv, AUTH_PROVIDER: '  Clerk_Api_Key ' }).AUTH_PROVIDER).toBe('clerk_api_key');
      expect(validateEnv({ ...baseEnv, AUTH_PROVIDER: 'API_KEY' }).AUTH_PROVIDER).toBe('api_key');
    });

    it('refuses an unrecognised AUTH_PROVIDER instead of silently disabling both auth paths', () => {
      expect(() => validateEnv({ ...baseEnv, AUTH_PROVIDER: 'oauth2' })).toThrow(/Invalid environment configuration/);
    });

    it('defaults the bootstrap key to unset and its tenant to legacy', () => {
      const env = validateEnv(baseEnv);
      expect(env.BOOTSTRAP_API_KEY).toBeUndefined();
      expect(env.BOOTSTRAP_API_KEY_TENANT_ID).toBe('legacy');
    });

    it('keeps the bootstrap key verbatim so migrate can hash exactly what the operator configured', () => {
      const env = validateEnv({
        ...baseEnv,
        BOOTSTRAP_API_KEY: 'fp_bootstr_secret',
        BOOTSTRAP_API_KEY_TENANT_ID: 'acme',
      });
      expect(env.BOOTSTRAP_API_KEY).toBe('fp_bootstr_secret');
      expect(env.BOOTSTRAP_API_KEY_TENANT_ID).toBe('acme');
    });

    it('refuses to boot a production process with authentication disabled', () => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', ENABLE_AUTH: 'false' })).toThrow(
        /ENABLE_AUTH must be true when NODE_ENV=production/,
      );
    });

    it('allows authentication to stay disabled outside production', () => {
      expect(validateEnv({ ...baseEnv, NODE_ENV: 'development', ENABLE_AUTH: 'false' }).ENABLE_AUTH).toBe(false);
      expect(validateEnv({ ...baseEnv, NODE_ENV: 'test', ENABLE_AUTH: 'false' }).ENABLE_AUTH).toBe(false);
      expect(validateEnv({ ...baseEnv, NODE_ENV: 'production', ENABLE_AUTH: 'true' }).ENABLE_AUTH).toBe(true);
    });
  });
});

describe('configuration', () => {
  it('exposes every new variable on the application configuration', () => {
    const config = configuration(validateEnv(baseEnv));

    expect(config).toMatchObject({
      shutdownTimeoutMs: 30_000,
      schedulerStuckFeedThresholdSeconds: 300,
      allowPrivateFeedHosts: false,
      feedFetchMaxBytes: 5 * 1024 * 1024,
      workerMetricsBind: '0.0.0.0',
      corsOrigins: [],
      bootstrapApiKeyTenantId: 'legacy',
      authProvider: 'clerk_api_key',
    });
    expect(config.metricsAuthToken).toBeUndefined();
    expect(config.bootstrapApiKey).toBeUndefined();
  });

  it('splits CORS_ORIGINS into a trimmed allow-list and drops empty entries', () => {
    const config = configuration(
      validateEnv({ ...baseEnv, CORS_ORIGINS: ' https://a.example.com , https://b.example.com ,, ' }),
    );

    expect(config.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('enables Swagger outside production and disables it inside, unless overridden', () => {
    expect(configuration(validateEnv({ ...baseEnv, NODE_ENV: 'development' })).enableSwagger).toBe(true);
    expect(configuration(validateEnv({ ...baseEnv, NODE_ENV: 'production', ENABLE_AUTH: 'true' })).enableSwagger).toBe(
      false,
    );
    expect(
      configuration(validateEnv({ ...baseEnv, NODE_ENV: 'production', ENABLE_AUTH: 'true', ENABLE_SWAGGER: 'true' }))
        .enableSwagger,
    ).toBe(true);
    expect(
      configuration(validateEnv({ ...baseEnv, NODE_ENV: 'development', ENABLE_SWAGGER: 'false' })).enableSwagger,
    ).toBe(false);
  });
});
