import { z } from 'zod';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const optionalUrl = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') {
      return undefined;
    }

    return value;
  },
  z.url().optional(),
);

const optionalString = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') {
      return undefined;
    }

    return value;
  },
  z.string().trim().min(1).optional(),
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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEBHOOK_NOTIFIER_URL: optionalUrl,
  WEBHOOK_NOTIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Maximum requests per second allowed per domain. Default: 2 */
  RATE_LIMIT_REQUESTS_PER_SECOND: z.coerce.number().int().positive().default(2),
  /** Maximum backoff time in milliseconds for rate limiting. Default: 60000 */
  RATE_LIMIT_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60000),
  /** Base delay for exponential backoff in milliseconds. Default: 1000 */
  RATE_LIMIT_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  /** Port on which the worker exposes its /metrics endpoint (aggregated by the API). Default: 3001 */
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3001),
  /** Maximum OPML upload size in bytes. Default: 10485760 (10 MiB). */
  OPML_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** Max jitter (seconds) for initial feed scheduling after OPML import. Default: 120 */
  OPML_INITIAL_JITTER_MAX_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** Rollout guard for CLI/TUI agent interface v1 adapters. */
  AGENT_INTERFACE_V1: featureFlag.default(true),
  /** Rollout guard for interactive TUI adapter surface. */
  TUI_ENABLED: featureFlag.default(true),
  /** Enables API key authentication for HTTP API endpoints. */
  ENABLE_AUTH: featureFlag.default(false),
  /** Auth provider selector for API authentication. */
  AUTH_PROVIDER: z.string().trim().min(1).default('clerk_api_key'),
  /** Secret key used to call Clerk API key verification endpoint. */
  CLERK_SECRET_KEY: optionalString,
  /** Base URL for Clerk API calls. */
  CLERK_API_URL: z.url().default('https://api.clerk.com'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
