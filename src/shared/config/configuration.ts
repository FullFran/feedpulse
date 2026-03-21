import { Env } from './env.schema';

export interface AppConfiguration {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webhookNotifierUrl?: string;
  webhookNotifierTimeoutMs: number;
  schedulerTickMs: number;
  schedulerBatchSize: number;
  workerConcurrency: number;
  fetchTimeoutMs: number;
  logLevel: Env['LOG_LEVEL'];
  rateLimitRequestsPerSecond: number;
  rateLimitMaxBackoffMs: number;
  rateLimitBaseBackoffMs: number;
  workerMetricsPort: number;
}

export const configuration = (env: Env): AppConfiguration => ({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  webhookNotifierUrl: env.WEBHOOK_NOTIFIER_URL,
  webhookNotifierTimeoutMs: env.WEBHOOK_NOTIFIER_TIMEOUT_MS,
  schedulerTickMs: env.SCHEDULER_TICK_MS,
  schedulerBatchSize: env.SCHEDULER_BATCH_SIZE,
  workerConcurrency: env.WORKER_CONCURRENCY,
  fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
  logLevel: env.LOG_LEVEL,
  rateLimitRequestsPerSecond: env.RATE_LIMIT_REQUESTS_PER_SECOND,
  rateLimitMaxBackoffMs: env.RATE_LIMIT_MAX_BACKOFF_MS,
  rateLimitBaseBackoffMs: env.RATE_LIMIT_BASE_BACKOFF_MS,
  workerMetricsPort: env.WORKER_METRICS_PORT,
});
