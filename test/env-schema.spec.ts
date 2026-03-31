import { validateEnv } from '../src/shared/config/env.schema';

describe('validateEnv', () => {
  it('accepts an empty webhook notifier url in local env files', () => {
    const env = validateEnv({
      NODE_ENV: 'development',
      PORT: '3000',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:55432/rss_monitor',
      REDIS_URL: 'redis://localhost:56379',
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
    expect(env.TELEGRAM_API_URL).toBe('https://api.telegram.org');
  });
});
