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

import type { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AlertDeliveryQueue } from '../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../src/infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../src/infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../src/infrastructure/queue/opml-parse-preview.queue';
import { ALERT_DELIVERY_QUEUE_NAME, FETCH_FEED_QUEUE_NAME } from '../src/infrastructure/queue/queue.constants';
import { AppConfigService } from '../src/shared/config/app-config.service';
import type { AppConfiguration } from '../src/shared/config/configuration';

const addMock = jest.fn();
const getJobMock = jest.fn();
const closeMock = jest.fn();
const queueConstructorMock = jest.fn();
const workerConstructorMock = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((...args: unknown[]) => {
    queueConstructorMock(...args);
    return {
      add: addMock,
      getJob: getJobMock,
      close: closeMock,
    };
  }),
  Worker: jest.fn().mockImplementation((...args: unknown[]) => {
    workerConstructorMock(...args);
    return { close: jest.fn(), on: jest.fn() };
  }),
}));

const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 1_000;

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
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    rateLimitRequestsPerSecond: 2,
    rateLimitMaxBackoffMs: RATE_LIMIT_MAX_BACKOFF_MS,
    rateLimitBaseBackoffMs: 1000,
    nodeEnv: 'test',
    logLevel: 'error',
  };

  return new AppConfigService({
    get: <T>(key: keyof typeof values): T => values[key] as T,
  } as unknown as ConfigService<AppConfiguration, true>);
}

function lastQueueOptions(): { defaultJobOptions: { removeOnComplete: unknown } } {
  const calls = queueConstructorMock.mock.calls;
  return calls[calls.length - 1][1] as { defaultJobOptions: { removeOnComplete: unknown } };
}

describe('queue job IDs', () => {
  beforeEach(() => {
    addMock.mockReset();
    getJobMock.mockReset();
    getJobMock.mockResolvedValue(undefined);
    closeMock.mockReset();
    queueConstructorMock.mockReset();
    workerConstructorMock.mockReset();
    (Queue as unknown as jest.Mock).mockClear();
  });

  it('uses BullMQ-safe deduplicated IDs for feed check jobs', async () => {
    const queue = new FetchFeedQueue(createConfigService());

    const result = await queue.enqueue({
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
    expect(result).toEqual({ jobId: 'feed-42', deduplicated: false });
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

  it('reports a scheduled feed job as deduplicated instead of pretending it was queued', async () => {
    getJobMock.mockResolvedValue({ id: 'feed-42' });
    const queue = new FetchFeedQueue(createConfigService());

    const result = await queue.enqueue({
      feedId: 42,
      queuedAt: '2026-03-21T00:00:00.000Z',
      attempt: 1,
      source: 'scheduler',
    });

    expect(result).toEqual({ jobId: 'feed-42', deduplicated: true });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('gives manual checks a unique job id so they are never swallowed by a scheduled job', async () => {
    const queue = new FetchFeedQueue(createConfigService());

    const first = await queue.enqueue({
      feedId: 42,
      queuedAt: '2026-03-21T00:00:00.000Z',
      attempt: 0,
      source: 'manual',
    });

    expect(first.jobId).toMatch(/^feed-42-manual-\d+$/);
    expect(first.jobId).not.toContain(':');
    expect(first.deduplicated).toBe(false);
    // A unique id has nothing to collide with, so the lookup round-trip is skipped.
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it.each([
    ['fetch feed', () => new FetchFeedQueue(createConfigService())],
    ['alert delivery', () => new AlertDeliveryQueue(createConfigService())],
    ['OPML parse preview', () => new OpmlParsePreviewQueue(createConfigService())],
    ['OPML apply import', () => new OpmlApplyImportQueue(createConfigService())],
  ])('does not retain completed %s jobs, because their job id derives from a stable entity id', (_name, build) => {
    build();

    // Regression guard: BullMQ treats add() with an existing jobId as a no-op, and a retained
    // completed job still counts. With numeric retention, re-enqueueing an entity whose last
    // job is among the retained completions is silently dropped until retention evicts it.
    expect(lastQueueOptions().defaultJobOptions.removeOnComplete).toBe(true);
  });

  it('gives the feed worker a lock long enough for rate-limit backoff plus the fetch timeout', () => {
    const queue = new FetchFeedQueue(createConfigService());

    queue.createWorker(async () => undefined);

    const workerOptions = workerConstructorMock.mock.calls[0][2] as { lockDuration: number };
    expect(workerOptions.lockDuration).toBeGreaterThan(RATE_LIMIT_MAX_BACKOFF_MS + FETCH_TIMEOUT_MS);
  });

  it('hands the full job to the feed processor so long jobs can extend their lock', async () => {
    const queue = new FetchFeedQueue(createConfigService());
    const processor = jest.fn().mockResolvedValue(undefined);

    queue.createWorker(processor);

    const bullProcessor = workerConstructorMock.mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { data: { feedId: 42, queuedAt: '2026-03-21T00:00:00.000Z', attempt: 1 }, extendLock: jest.fn() };
    await bullProcessor(job);

    expect(processor).toHaveBeenCalledWith(job);
  });
});
