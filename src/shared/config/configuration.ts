import { Env } from './env.schema';

export interface AppConfiguration {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webhookNotifierUrl?: string;
  webhookNotifierTimeoutMs: number;
  resendApiKey?: string;
  resendFromEmail?: string;
  schedulerTickMs: number;
  schedulerBatchSize: number;
  workerConcurrency: number;
  fetchTimeoutMs: number;
  logLevel: Env['LOG_LEVEL'];
  rateLimitRequestsPerSecond: number;
  rateLimitMaxBackoffMs: number;
  rateLimitBaseBackoffMs: number;
  workerMetricsPort: number;
  opmlUploadMaxBytes: number;
  opmlInitialJitterMaxSeconds: number;
  agentInterfaceV1: boolean;
  tuiEnabled: boolean;
  enableAuth: boolean;
  authProvider: string;
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
  clerkApiUrl: string;
}

export const configuration = (env: Env): AppConfiguration => ({
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  webhookNotifierUrl: env.WEBHOOK_NOTIFIER_URL,
  webhookNotifierTimeoutMs: env.WEBHOOK_NOTIFIER_TIMEOUT_MS,
  resendApiKey: env.RESEND_API_KEY,
  resendFromEmail: env.RESEND_FROM_EMAIL,
  schedulerTickMs: env.SCHEDULER_TICK_MS,
  schedulerBatchSize: env.SCHEDULER_BATCH_SIZE,
  workerConcurrency: env.WORKER_CONCURRENCY,
  fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
  logLevel: env.LOG_LEVEL,
  rateLimitRequestsPerSecond: env.RATE_LIMIT_REQUESTS_PER_SECOND,
  rateLimitMaxBackoffMs: env.RATE_LIMIT_MAX_BACKOFF_MS,
  rateLimitBaseBackoffMs: env.RATE_LIMIT_BASE_BACKOFF_MS,
  workerMetricsPort: env.WORKER_METRICS_PORT,
  opmlUploadMaxBytes: env.OPML_UPLOAD_MAX_BYTES,
  opmlInitialJitterMaxSeconds: env.OPML_INITIAL_JITTER_MAX_SECONDS,
  agentInterfaceV1: env.AGENT_INTERFACE_V1,
  tuiEnabled: env.TUI_ENABLED,
  enableAuth: env.ENABLE_AUTH,
  authProvider: env.AUTH_PROVIDER,
  clerkSecretKey: env.CLERK_SECRET_KEY,
  clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
  clerkApiUrl: env.CLERK_API_URL,
});
