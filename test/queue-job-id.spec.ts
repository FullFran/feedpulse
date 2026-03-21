process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.WEBHOOK_NOTIFIER_URL = 'https://example.com/webhook';
process.env.WEBHOOK_NOTIFIER_TIMEOUT_MS = '500';
process.env.SCHEDULER_TICK_MS = '1000';
process.env.SCHEDULER_BATCH_SIZE = '10';
process.env.WORKER_CONCURRENCY = '1';
process.env.FETCH_TIMEOUT_MS = '1000';
process.env.LOG_LEVEL = 'error';

import { ConfigService } from '@nestjs/config';

import { AlertDeliveryQueue } from '../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../src/infrastructure/queue/fetch-feed.queue';
import {
  ALERT_DELIVERY_QUEUE_NAME,
  FETCH_FEED_QUEUE_NAME,
} from '../src/infrastructure/queue/queue.constants';
import { AppConfigService } from '../src/shared/config/app-config.service';
import { AppConfiguration } from '../src/shared/config/configuration';

const addMock = jest.fn();
const closeMock = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: addMock,
    close: closeMock,
  })),
  Worker: jest.fn(),
}));

function createConfigService(): AppConfigService {
  const values = {
    port: 3000,
    databaseUrl: 'postgres://postgres:postgres@localhost:5432/rss_monitor_test',
    redisUrl: 'redis://localhost:6379',
    webhookNotifierUrl: 'https://example.com/webhook',
    webhookNotifierTimeoutMs: 500,
    schedulerTickMs: 1000,
    schedulerBatchSize: 10,
    workerConcurrency: 1,
    fetchTimeoutMs: 1000,
    nodeEnv: 'test',
    logLevel: 'error',
  };

  return new AppConfigService({
    get: <T>(key: keyof typeof values): T => values[key] as T,
  } as unknown as ConfigService<AppConfiguration, true>);
}

describe('queue job IDs', () => {
  beforeEach(() => {
    addMock.mockReset();
    closeMock.mockReset();
  });

  it('uses BullMQ-safe deduplicated IDs for feed check jobs', async () => {
    const queue = new FetchFeedQueue(createConfigService());

    await queue.enqueue({
      feedId: 42,
      queuedAt: '2026-03-21T00:00:00.000Z',
      attempt: 0,
    });

    expect(addMock).toHaveBeenCalledWith(
      FETCH_FEED_QUEUE_NAME,
      expect.objectContaining({ feedId: 42 }),
      expect.objectContaining({ jobId: 'feed-42' }),
    );
    expect(addMock.mock.calls[0][2].jobId).not.toContain(':');
  });

  it('uses BullMQ-safe deduplicated IDs for alert delivery jobs', async () => {
    const queue = new AlertDeliveryQueue(createConfigService());

    await queue.enqueue({
      alertId: 7,
      queuedAt: '2026-03-21T00:00:00.000Z',
      source: 'manual',
    });

    expect(addMock).toHaveBeenCalledWith(
      ALERT_DELIVERY_QUEUE_NAME,
      expect.objectContaining({ alertId: 7 }),
      expect.objectContaining({ jobId: 'alert-7' }),
    );
    expect(addMock.mock.calls[0][2].jobId).not.toContain(':');
  });
});
