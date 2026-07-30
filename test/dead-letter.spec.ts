import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { DatabaseService } from '../src/infrastructure/persistence/database.service';
import type { ReadinessService } from '../src/infrastructure/persistence/readiness.service';
import {
  capDeadLetterError,
  capDeadLetterPayload,
  DEAD_LETTER_MAX_ERROR_CHARS,
  DEAD_LETTER_MAX_PAYLOAD_BYTES,
  DEAD_LETTER_PURGE_INTERVAL_MS,
  DEAD_LETTER_RETENTION_DAYS,
  DeadLetterRepository,
  isKnownQueueName,
  KNOWN_QUEUE_NAMES,
} from '../src/infrastructure/queue/dead-letter.repository';
import {
  ALERT_DELIVERY_QUEUE_NAME,
  FETCH_FEED_QUEUE_NAME,
  OPML_PARSE_PREVIEW_QUEUE_NAME,
} from '../src/infrastructure/queue/queue.constants';
import type { FetchFeedJobData } from '../src/infrastructure/queue/queue.constants';
import type { FeedsRepository } from '../src/modules/feeds/feeds.repository';
import { ReleaseStuckFeedsUseCase } from '../src/modules/ingestion/application/release-stuck-feeds.use-case';
import { classifyAttempt, WorkerRunner } from '../src/modules/ingestion/worker.runner';
import { SHARED_METRICS_REGISTRY } from '../src/modules/observability/metrics-registry';
import { QueueMetricsService } from '../src/modules/observability/queue-metrics.service';

/**
 * Reads one sample out of the shared Prometheus registry.
 *
 * Going through `getMetricsAsJSON()` rather than prom-client internals is
 * deliberate: it is the same path `/metrics` renders from, so a metric that this
 * helper can see is a metric an operator can see.
 */
async function counterValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metrics = await SHARED_METRICS_REGISTRY.getMetricsAsJSON();
  const metric = metrics.find((candidate) => candidate.name === name) as
    { values: Array<{ labels: Record<string, string | number>; value: number }> } | undefined;

  if (!metric) {
    return 0;
  }

  const sample = metric.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => String(value.labels[key]) === expected),
  );

  return sample?.value ?? 0;
}

/** Renders the registry exactly as GET /metrics does. */
async function renderedMetrics(): Promise<string> {
  return SHARED_METRICS_REGISTRY.metrics();
}

/** Constructor slots this suite never exercises; only reached through DI in production. */
function notUsed<T>(): T {
  return undefined as unknown as T;
}

interface FakeJobOptions {
  id?: string;
  attemptsMade: number;
  attempts?: number;
  data?: unknown;
}

function fakeJob({ id = 'feed-7', attemptsMade, attempts, data = { feedId: 7 } }: FakeJobOptions): Job<unknown> {
  return { id, attemptsMade, opts: attempts === undefined ? {} : { attempts }, data } as unknown as Job<unknown>;
}

describe('classifyAttempt', () => {
  it('marks the last configured attempt as final', () => {
    expect(classifyAttempt({ attemptsMade: 3, opts: { attempts: 3 } })).toEqual({
      finality: 'true',
      attemptsMade: 3,
      maxAttempts: 3,
    });
  });

  it('marks an earlier attempt as retryable', () => {
    expect(classifyAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toEqual({
      finality: 'false',
      attemptsMade: 1,
      maxAttempts: 3,
    });
  });

  it('treats a job with no configured attempts as single-shot, so its first failure is final', () => {
    expect(classifyAttempt({ attemptsMade: 1, opts: {} }).finality).toBe('true');
  });

  it('never reports fewer attempts than BullMQ did, even past the configured maximum', () => {
    // A job requeued by hand can overshoot; `>=` keeps that terminal instead of retryable.
    expect(classifyAttempt({ attemptsMade: 9, opts: { attempts: 3 } }).finality).toBe('true');
  });

  it('reports `unknown` when BullMQ emits `failed` without a job', () => {
    expect(classifyAttempt(undefined)).toEqual({ finality: 'unknown', attemptsMade: 0, maxAttempts: 0 });
  });
});

describe('capDeadLetterPayload', () => {
  it('passes a small payload through untouched', () => {
    const payload = { feedId: 7, queuedAt: '2026-07-30T00:00:00.000Z' };
    expect(capDeadLetterPayload(payload)).toBe(payload);
  });

  it('replaces an oversized payload with a marker instead of invalid JSON', () => {
    const payload = { opmlXml: 'x'.repeat(DEAD_LETTER_MAX_PAYLOAD_BYTES * 2) };

    const capped = capDeadLetterPayload(payload) as {
      truncated: boolean;
      reason: string;
      byteLength: number;
      preview: string;
    };

    expect(capped.truncated).toBe(true);
    expect(capped.reason).toBe('payload_too_large');
    expect(capped.byteLength).toBeGreaterThan(DEAD_LETTER_MAX_PAYLOAD_BYTES);
    expect(capped.preview.length).toBeLessThanOrEqual(512);
    expect(() => JSON.stringify(capped)).not.toThrow();
  });

  it('degrades to a marker rather than throwing on a circular payload', () => {
    const payload: Record<string, unknown> = { feedId: 7 };
    payload.self = payload;

    expect(capDeadLetterPayload(payload)).toEqual({ truncated: true, reason: 'not_serializable' });
  });

  it('normalizes an absent payload to SQL-insertable null', () => {
    expect(capDeadLetterPayload(undefined)).toBeNull();
  });
});

describe('capDeadLetterError', () => {
  it('keeps a short message verbatim', () => {
    expect(capDeadLetterError('boom')).toBe('boom');
  });

  it('keeps null as null', () => {
    expect(capDeadLetterError(null)).toBeNull();
  });

  it('trims a long message and says so', () => {
    const capped = capDeadLetterError('e'.repeat(DEAD_LETTER_MAX_ERROR_CHARS + 100));

    expect(capped).toContain('[truncated]');
    expect(capped?.length).toBeLessThan(DEAD_LETTER_MAX_ERROR_CHARS + 40);
  });
});

describe('KNOWN_QUEUE_NAMES', () => {
  it('is the closed set of the four deployed queues', () => {
    expect([...KNOWN_QUEUE_NAMES]).toEqual(['fetch-feed', 'alert-delivery', 'opml-parse-preview', 'opml-apply-import']);
  });

  it('rejects anything outside that set, which is what keeps the `queue` label bounded', () => {
    expect(isKnownQueueName('fetch-feed')).toBe(true);
    expect(isKnownQueueName('feed-1234')).toBe(false);
  });
});

describe('DeadLetterRepository', () => {
  let query: jest.Mock;
  let repository: DeadLetterRepository;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    repository = new DeadLetterRepository({ query } as unknown as DatabaseService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('inserts the queue, job id, payload, capped error and attempt count', async () => {
    await repository.record({
      queue: ALERT_DELIVERY_QUEUE_NAME,
      jobId: 'alert-42',
      payload: { alertId: 42, source: 'ingestion' },
      error: 'webhook_unreachable',
      attempts: 4,
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO dead_letter_jobs');
    expect(values[0]).toBe('alert-delivery');
    expect(values[1]).toBe('alert-42');
    expect(JSON.parse(values[2] as string)).toEqual({ alertId: 42, source: 'ingestion' });
    expect(values[3]).toBe('webhook_unreachable');
    expect(values[4]).toBe(4);
  });

  it('propagates a write failure so the caller can count it', async () => {
    query.mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      repository.record({
        queue: FETCH_FEED_QUEUE_NAME,
        jobId: 'feed-1',
        payload: {},
        error: 'boom',
        attempts: 3,
      }),
    ).rejects.toThrow('connection terminated');
  });

  it('runs retention on the first record and then throttles it', async () => {
    const entry = {
      queue: FETCH_FEED_QUEUE_NAME,
      jobId: 'feed-1',
      payload: {},
      error: 'boom',
      attempts: 3,
    } as const;

    await repository.record(entry);

    const purgeCalls = query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM dead_letter_jobs'));
    expect(purgeCalls).toHaveLength(1);
    expect((purgeCalls[0] as [string, unknown[]])[1]).toEqual([DEAD_LETTER_RETENTION_DAYS]);

    await repository.record(entry);
    await repository.record(entry);

    expect(query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM dead_letter_jobs'))).toHaveLength(1);
  });

  it('runs retention again once the throttle window has elapsed', async () => {
    const entry = {
      queue: FETCH_FEED_QUEUE_NAME,
      jobId: 'feed-1',
      payload: {},
      error: 'boom',
      attempts: 3,
    } as const;

    // Well past the throttle window so the very first record still purges.
    const startMs = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(startMs);
    await repository.record(entry);

    nowSpy.mockReturnValue(startMs + DEAD_LETTER_PURGE_INTERVAL_MS + 1);
    await repository.record(entry);

    expect(query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM dead_letter_jobs'))).toHaveLength(2);
  });

  it('never lets a retention failure lose the dead letter that was just written', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 }).mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(
      repository.record({
        queue: FETCH_FEED_QUEUE_NAME,
        jobId: 'feed-1',
        payload: {},
        error: 'boom',
        attempts: 3,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a non-positive retention window instead of deleting the whole table', async () => {
    await repository.purgeOlderThan(0);
    await repository.purgeOlderThan(Number.NaN);

    for (const call of query.mock.calls) {
      expect((call as [string, unknown[]])[1]).toEqual([DEAD_LETTER_RETENTION_DAYS]);
    }
  });

  it('clamps listRecent to a sane page size in both directions', async () => {
    await repository.listRecent(null, 100_000);
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual([200]);

    await repository.listRecent(FETCH_FEED_QUEUE_NAME, 0);
    expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual(['fetch-feed', 1]);
  });

  it('maps rows onto a serializable view', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '9007199254740993',
          queue: 'fetch-feed',
          job_id: 'feed-7',
          payload: { feedId: 7 },
          error: 'timeout',
          attempts: 3,
          failed_at: new Date('2026-07-30T10:00:00.000Z'),
        },
      ],
      rowCount: 1,
    });

    await expect(repository.listRecent('fetch-feed', 10)).resolves.toEqual([
      {
        id: '9007199254740993',
        queue: 'fetch-feed',
        jobId: 'feed-7',
        payload: { feedId: 7 },
        error: 'timeout',
        attempts: 3,
        failedAt: '2026-07-30T10:00:00.000Z',
      },
    ]);
  });
});

describe('WorkerRunner job failure handling', () => {
  let record: jest.Mock;
  let queueMetrics: QueueMetricsService;
  let runner: WorkerRunner;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  function buildRunner(recordImpl: jest.Mock): WorkerRunner {
    return new WorkerRunner(
      notUsed(),
      notUsed(),
      notUsed(),
      notUsed(),
      notUsed(),
      notUsed(),
      notUsed(),
      notUsed(),
      { record: recordImpl } as unknown as DeadLetterRepository,
      queueMetrics,
    );
  }

  beforeEach(() => {
    queueMetrics = new QueueMetricsService();
    queueMetrics.resetForTesting();
    record = jest.fn().mockResolvedValue(undefined);
    runner = buildRunner(record);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records a job that failed on its final attempt, with its payload and attempt count', async () => {
    const data: FetchFeedJobData = { feedId: 7, queuedAt: '2026-07-30T00:00:00.000Z', attempt: 3 };

    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ id: 'feed-7', attemptsMade: 3, attempts: 3, data }),
      error: new Error('ETIMEDOUT'),
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      queue: 'fetch-feed',
      jobId: 'feed-7',
      payload: data,
      error: 'ETIMEDOUT',
      attempts: 3,
    });
  });

  it('does NOT record a job that failed on attempt 1 of 3', async () => {
    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 1, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });

    expect(record).not.toHaveBeenCalled();
  });

  it('sets the `final` label correctly for a terminal failure', async () => {
    const before = await counterValue('rss_jobs_failed_total', { queue: 'fetch-feed', final: 'true' });

    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 3, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });

    await expect(counterValue('rss_jobs_failed_total', { queue: 'fetch-feed', final: 'true' })).resolves.toBe(
      before + 1,
    );
    await expect(counterValue('rss_jobs_failed_total', { queue: 'fetch-feed', final: 'false' })).resolves.toBe(0);
    await expect(counterValue('rss_jobs_dead_lettered_total', { queue: 'fetch-feed' })).resolves.toBe(1);
  });

  it('sets the `final` label correctly for a retryable failure', async () => {
    await runner.handleJobFailure({
      queue: ALERT_DELIVERY_QUEUE_NAME,
      subject: 'Alert delivery job 42',
      job: fakeJob({ id: 'alert-42', attemptsMade: 2, attempts: 4, data: { alertId: 42 } }),
      error: new Error('502'),
    });

    await expect(counterValue('rss_jobs_failed_total', { queue: 'alert-delivery', final: 'false' })).resolves.toBe(1);
    await expect(counterValue('rss_jobs_failed_total', { queue: 'alert-delivery', final: 'true' })).resolves.toBe(0);
    await expect(counterValue('rss_jobs_dead_lettered_total', { queue: 'alert-delivery' })).resolves.toBe(0);
  });

  it('logs a retryable attempt at warn and a terminal one at error', async () => {
    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 1, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt 1/3'));
    expect(error).not.toHaveBeenCalled();

    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 3, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed permanently after 3/3 attempts'));
  });

  it('labels a failure with no job as `unknown` rather than pretending it was retryable', async () => {
    await runner.handleJobFailure({
      queue: OPML_PARSE_PREVIEW_QUEUE_NAME,
      subject: 'OPML parse job unknown',
      job: undefined,
      error: new Error('missing key for job'),
    });

    await expect(
      counterValue('rss_jobs_failed_total', { queue: 'opml-parse-preview', final: 'unknown' }),
    ).resolves.toBe(1);
    expect(record).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot be dead-lettered'));
  });

  it('counts a dead letter write failure instead of crashing the worker', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('relation "dead_letter_jobs" does not exist'));
    const failingRunner = buildRunner(failing);

    await expect(
      failingRunner.handleJobFailure({
        queue: FETCH_FEED_QUEUE_NAME,
        subject: 'Feed job 7',
        job: fakeJob({ attemptsMade: 3, attempts: 3 }),
        error: new Error('ETIMEDOUT'),
      }),
    ).resolves.toBeUndefined();

    await expect(counterValue('rss_dead_letter_write_failures_total', { queue: 'fetch-feed' })).resolves.toBe(1);
    await expect(counterValue('rss_jobs_dead_lettered_total', { queue: 'fetch-feed' })).resolves.toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to dead-letter'));
  });

  it('falls back to a placeholder job id rather than writing null', async () => {
    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: { attemptsMade: 1, opts: {}, data: { feedId: 7 } } as unknown as Job<unknown>,
      error: new Error('ETIMEDOUT'),
    });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'unknown' }));
  });

  it('drains dead letter writes still in flight before shutdown completes', async () => {
    let releaseWrite: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    let written = false;
    const slowRecord = jest.fn().mockImplementation(async () => {
      await blocked;
      written = true;
    });
    const slowRunner = buildRunner(slowRecord);

    // `handleJobFailure` is what the `failed` listener hands to `trackFailure`;
    // driving it through `start()` would need a live Redis.
    const inFlight = slowRunner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 3, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });

    expect(written).toBe(false);
    releaseWrite();
    await inFlight;
    await slowRunner.onApplicationShutdown();

    expect(written).toBe(true);
  });

  it('exposes every queue counter through the rendered /metrics payload', async () => {
    await runner.handleJobFailure({
      queue: FETCH_FEED_QUEUE_NAME,
      subject: 'Feed job 7',
      job: fakeJob({ attemptsMade: 3, attempts: 3 }),
      error: new Error('ETIMEDOUT'),
    });
    queueMetrics.incrementFeedsReleasedStuck(2);

    const rendered = await renderedMetrics();

    expect(rendered).toContain('rss_jobs_failed_total{queue="fetch-feed",final="true"} 1');
    expect(rendered).toContain('rss_jobs_dead_lettered_total{queue="fetch-feed"} 1');
    expect(rendered).toContain('rss_feeds_released_stuck_total 2');
  });

  it('keeps the `queue` label inside the fixed four-name set', async () => {
    for (const queue of KNOWN_QUEUE_NAMES) {
      await runner.handleJobFailure({
        queue: queue,
        subject: `job on ${queue}`,
        job: fakeJob({ attemptsMade: 1, attempts: 3 }),
        error: new Error('boom'),
      });
    }

    const metrics = await SHARED_METRICS_REGISTRY.getMetricsAsJSON();
    const failed = metrics.find((candidate) => candidate.name === 'rss_jobs_failed_total') as {
      values: Array<{ labels: Record<string, string | number> }>;
    };
    const labelledQueues = new Set(failed.values.map((value) => String(value.labels.queue)));

    expect([...labelledQueues].sort()).toEqual([...KNOWN_QUEUE_NAMES].sort());
  });
});

describe('ReleaseStuckFeedsUseCase metrics', () => {
  let queueMetrics: QueueMetricsService;

  function createUseCase(released: number): ReleaseStuckFeedsUseCase {
    const readinessService = {
      assertSchemaReady: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReadinessService;
    const feedsRepository = { releaseStuckFeeds: jest.fn().mockResolvedValue(released) } as unknown as FeedsRepository;

    return new ReleaseStuckFeedsUseCase(
      readinessService,
      feedsRepository,
      { schedulerStuckFeedThresholdSeconds: 300 },
      queueMetrics,
    );
  }

  beforeEach(() => {
    queueMetrics = new QueueMetricsService();
    queueMetrics.resetForTesting();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts released feeds so a dying worker is alertable, not just logged', async () => {
    await createUseCase(3).execute();

    await expect(counterValue('rss_feeds_released_stuck_total')).resolves.toBe(3);
  });

  it('leaves the counter alone when nothing was stuck', async () => {
    await createUseCase(0).execute();

    await expect(counterValue('rss_feeds_released_stuck_total')).resolves.toBe(0);
  });

  it('still runs when no metrics service is injected', async () => {
    const readinessService = {
      assertSchemaReady: jest.fn().mockResolvedValue(undefined),
    } as unknown as ReadinessService;
    const feedsRepository = { releaseStuckFeeds: jest.fn().mockResolvedValue(2) } as unknown as FeedsRepository;
    const useCase = new ReleaseStuckFeedsUseCase(readinessService, feedsRepository, {
      schedulerStuckFeedThresholdSeconds: 300,
    });

    await expect(useCase.execute()).resolves.toEqual({ released: 2 });
  });
});
