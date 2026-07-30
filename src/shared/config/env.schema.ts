import { z } from 'zod';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const optionalUrl = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  return value;
}, z.url().optional());

const optionalString = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  return value;
}, z.string().trim().min(1).optional());

const optionalEmail = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  return value;
}, z.email().optional());

/** Placeholders that look configured but are public knowledge. Rejected outright. */
const KNOWN_WEAK_MASTER_KEYS = new Set([
  'change_me',
  'change-me',
  'changeme',
  'password',
  'secret',
  'tenant-secrets-master-key',
  'replace-me',
]);

/** Minimum decoded key material accepted for `TENANT_SECRETS_MASTER_KEY`, in bytes. */
const MASTER_KEY_MIN_BYTES = 32;

/**
 * `TENANT_SECRETS_MASTER_KEY` derives the AES-256-GCM key that protects every
 * per-tenant Telegram bot token, so an operator passphrase is brute-forceable
 * offline if the database leaks. It stays OPTIONAL — `canUseTenantSecrets()`
 * returns false when unset and tenants simply cannot store their own bot token,
 * which is a supported deployment — but a value that IS present must carry real
 * entropy.
 */
const optionalMasterKey = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') {
      return undefined;
    }

    return value;
  },
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !KNOWN_WEAK_MASTER_KEYS.has(value.toLowerCase()), {
      message:
        'TENANT_SECRETS_MASTER_KEY is a well-known placeholder. Generate a real key with `openssl rand -base64 32`.',
    })
    .refine((value) => Buffer.from(value, 'base64').length >= MASTER_KEY_MIN_BYTES, {
      message: `TENANT_SECRETS_MASTER_KEY must decode to at least ${MASTER_KEY_MIN_BYTES} bytes of base64 key material. Generate it with \`openssl rand -base64 32\`.`,
    })
    .optional(),
);

const featureFlag = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) {
      return true;
    }

    if (FALSE_VALUES.has(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

/** Accepted values for `AUTH_PROVIDER`; anything else fails startup instead of silently disabling auth. */
export const AUTH_PROVIDERS = ['api_key', 'clerk', 'clerk_api_key'] as const;

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEBHOOK_NOTIFIER_URL: optionalUrl,
  WEBHOOK_NOTIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  RESEND_API_KEY: optionalString,
  RESEND_FROM_EMAIL: optionalEmail,
  /**
   * Maximum alert emails a single tenant may send per day, counted in Redis on a
   * UTC day boundary. 0 disables the quota entirely, which is why this is
   * `min(0)` rather than `positive()`. Default: 100 (the Resend free tier).
   */
  RESEND_DAILY_LIMIT: z.coerce.number().int().min(0).default(100),
  TELEGRAM_BOT_TOKEN: optionalString,
  TENANT_SECRETS_MASTER_KEY: optionalMasterKey,
  TELEGRAM_API_URL: z.url().default('https://api.telegram.org'),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Force-exit deadline armed after the first SIGINT/SIGTERM, in milliseconds. Default: 30000 */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  /**
   * Age (seconds) after which a scheduler claim on a feed is considered abandoned and released.
   * Must stay above the worst-case job duration (RATE_LIMIT_MAX_BACKOFF_MS + FETCH_TIMEOUT_MS);
   * a lower value releases feeds that are still being fetched and causes duplicate requests.
   * Default: 300
   */
  SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS: z.coerce.number().int().positive().default(300),
  // --- OUTBOUND fetch pacing (per feed domain, applied by DomainRateLimiter) ---
  // These three throttle the requests FeedPulse makes to origins. They are a
  // different concern from the RATE_LIMIT_*_REQUESTS keys below, which cap the
  // requests clients make to FeedPulse.
  /** Maximum requests per second allowed per domain. Default: 2 */
  RATE_LIMIT_REQUESTS_PER_SECOND: z.coerce.number().int().positive().default(2),
  /** Maximum backoff time in milliseconds for rate limiting. Default: 60000 */
  RATE_LIMIT_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
  /** Base delay for exponential backoff in milliseconds. Default: 1000 */
  RATE_LIMIT_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),

  // --- INBOUND HTTP rate limiting (per tenant, applied by RateLimitGuard) ---
  // Counters live in REDIS_URL, so the ceilings hold across API replicas instead
  // of being multiplied by the replica count.
  /** Length of the inbound HTTP rate-limit window, in seconds. Default: 60 */
  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  /** Inbound requests per window per tenant across all /api/ routes. 0 disables the bucket. Default: 300 */
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().nonnegative().default(300),
  /**
   * Inbound requests per window per tenant on the enqueue/outbound endpoints
   * (check-now, feeds/validate, OPML import + confirm, alerts/:id/send).
   * 0 disables the bucket. Default: 30
   */
  RATE_LIMIT_WRITE_MAX_REQUESTS: z.coerce.number().int().nonnegative().default(30),
  /** Maximum feed rows a single tenant may own. 0 disables the cap. Default: 500 */
  MAX_FEEDS_PER_TENANT: z.coerce.number().int().nonnegative().default(500),
  /** Port on which the worker exposes its /metrics endpoint (aggregated by the API). Default: 3001 */
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3001),
  /**
   * Interface the worker metrics HTTP server binds to. Defaults to 0.0.0.0 because the API
   * scrapes the worker across the compose network. Set to 127.0.0.1 when the worker is not
   * isolated in a private network.
   */
  WORKER_METRICS_BIND: z.string().trim().min(1).default('0.0.0.0'),
  /**
   * Optional bearer token required by GET /metrics on both the API and the worker metrics
   * server. Unset leaves the endpoint open (development / private network only).
   */
  METRICS_AUTH_TOKEN: optionalString,
  /** Comma-separated allow-list of browser origins for CORS. Empty/unset disables CORS entirely. */
  CORS_ORIGINS: optionalString,
  /** Serve Swagger UI at /docs. Defaults to true outside production. */
  ENABLE_SWAGGER: featureFlag.optional(),
  /**
   * Allows fetching feeds and webhooks on loopback/private/link-local hosts.
   * Self-hosted and docker-smoke only.
   */
  ALLOW_PRIVATE_FEED_HOSTS: featureFlag.default(false),
  /** Maximum feed response body read from an origin, in bytes. Default: 5242880 (5 MiB). */
  FEED_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  /** Maximum OPML upload size in bytes. Default: 10485760 (10 MiB). */
  OPML_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /** Max jitter (seconds) for initial feed scheduling after OPML import. Default: 120 */
  OPML_INITIAL_JITTER_MAX_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** Rollout guard for CLI/TUI agent interface v1 adapters. */
  AGENT_INTERFACE_V1: featureFlag.default(true),
  /** Rollout guard for interactive TUI adapter surface. */
  TUI_ENABLED: featureFlag.default(true),
  /**
   * Enables API key authentication for HTTP API endpoints. When false every request resolves
   * to the shared `legacy` tenant with no credential, which is a local-development mode only:
   * the refinement below refuses to boot a production process with it disabled.
   */
  ENABLE_AUTH: featureFlag.default(false),
  /** Auth provider selector for API authentication. */
  AUTH_PROVIDER: z
    .preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value), z.enum(AUTH_PROVIDERS))
    .default('clerk_api_key'),
  /** Plaintext API key seeded into the api_keys table at migrate time so `docker compose up` works out of the box. */
  BOOTSTRAP_API_KEY: optionalString,
  /** Tenant the bootstrap API key is issued for. */
  BOOTSTRAP_API_KEY_TENANT_ID: z.string().trim().min(1).default('legacy'),
  /** Secret key used to call Clerk API key verification endpoint. */
  CLERK_SECRET_KEY: optionalString,
  /** Publishable key used by dashboard Clerk JS login flow. */
  CLERK_PUBLISHABLE_KEY: optionalString,
  /** Base URL for Clerk API calls. */
  CLERK_API_URL: z.url().default('https://api.clerk.com'),
});

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.ENABLE_AUTH === false) {
    ctx.addIssue({
      code: 'custom',
      path: ['ENABLE_AUTH'],
      message:
        'ENABLE_AUTH must be true when NODE_ENV=production. Disabling auth resolves every request to the shared legacy tenant.',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
