import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') {
      return undefined;
    }

    return value;
  },
  z.url().optional(),
);

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
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  return parsed.data;
}
