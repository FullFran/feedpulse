import type { Env } from './env.schema';

export interface AppConfiguration {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webhookNotifierUrl?: string;
  webhookNotifierTimeoutMs: number;
  resendApiKey?: string;
  resendFromEmail?: string;
  resendDailyLimit: number;
  telegramBotToken?: string;
  tenantSecretsMasterKey?: string;
  telegramApiUrl: string;
  schedulerTickMs: number;
  schedulerBatchSize: number;
  schedulerStuckFeedThresholdSeconds: number;
  workerConcurrency: number;
  fetchTimeoutMs: number;
  logLevel: Env['LOG_LEVEL'];
  shutdownTimeoutMs: number;
  rateLimitRequestsPerSecond: number;
  rateLimitMaxBackoffMs: number;
  rateLimitBaseBackoffMs: number;
  rateLimitTtlSeconds: number;
  rateLimitMaxRequests: number;
  rateLimitWriteMaxRequests: number;
  maxFeedsPerTenant: number;
  workerMetricsPort: number;
  workerMetricsBind: string;
  metricsAuthToken?: string;
  corsOrigins: string[];
  enableSwagger: boolean;
  allowPrivateFeedHosts: boolean;
  feedFetchMaxBytes: number;
  opmlUploadMaxBytes: number;
  opmlInitialJitterMaxSeconds: number;
  agentInterfaceV1: boolean;
  tuiEnabled: boolean;
  enableAuth: boolean;
  authProvider: Env['AUTH_PROVIDER'];
  bootstrapApiKey?: string;
  bootstrapApiKeyTenantId: string;
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
  resendDailyLimit: env.RESEND_DAILY_LIMIT,
  telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  tenantSecretsMasterKey: env.TENANT_SECRETS_MASTER_KEY,
  telegramApiUrl: env.TELEGRAM_API_URL,
  schedulerTickMs: env.SCHEDULER_TICK_MS,
  schedulerBatchSize: env.SCHEDULER_BATCH_SIZE,
  schedulerStuckFeedThresholdSeconds: env.SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS,
  workerConcurrency: env.WORKER_CONCURRENCY,
  fetchTimeoutMs: env.FETCH_TIMEOUT_MS,
  logLevel: env.LOG_LEVEL,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  rateLimitRequestsPerSecond: env.RATE_LIMIT_REQUESTS_PER_SECOND,
  rateLimitMaxBackoffMs: env.RATE_LIMIT_MAX_BACKOFF_MS,
  rateLimitBaseBackoffMs: env.RATE_LIMIT_BASE_BACKOFF_MS,
  rateLimitTtlSeconds: env.RATE_LIMIT_TTL_SECONDS,
  rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  rateLimitWriteMaxRequests: env.RATE_LIMIT_WRITE_MAX_REQUESTS,
  maxFeedsPerTenant: env.MAX_FEEDS_PER_TENANT,
  workerMetricsPort: env.WORKER_METRICS_PORT,
  workerMetricsBind: env.WORKER_METRICS_BIND,
  metricsAuthToken: env.METRICS_AUTH_TOKEN,
  corsOrigins: (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  enableSwagger: env.ENABLE_SWAGGER ?? env.NODE_ENV !== 'production',
  allowPrivateFeedHosts: env.ALLOW_PRIVATE_FEED_HOSTS,
  feedFetchMaxBytes: env.FEED_FETCH_MAX_BYTES,
  opmlUploadMaxBytes: env.OPML_UPLOAD_MAX_BYTES,
  opmlInitialJitterMaxSeconds: env.OPML_INITIAL_JITTER_MAX_SECONDS,
  agentInterfaceV1: env.AGENT_INTERFACE_V1,
  tuiEnabled: env.TUI_ENABLED,
  enableAuth: env.ENABLE_AUTH,
  authProvider: env.AUTH_PROVIDER,
  bootstrapApiKey: env.BOOTSTRAP_API_KEY,
  bootstrapApiKeyTenantId: env.BOOTSTRAP_API_KEY_TENANT_ID,
  clerkSecretKey: env.CLERK_SECRET_KEY,
  clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
  clerkApiUrl: env.CLERK_API_URL,
});
