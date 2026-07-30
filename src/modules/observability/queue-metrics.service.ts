import { Injectable } from '@nestjs/common';
import { Counter } from 'prom-client';
import type { KnownQueueName } from '../../infrastructure/queue/dead-letter.repository';
import { SHARED_METRICS_REGISTRY } from './metrics-registry';

/**
 * Whether a failure was the job's last attempt.
 *
 * `unknown` exists because BullMQ can emit `failed` with an undefined job (the job
 * was already evicted from Redis, or the lock was lost). Collapsing that case into
 * `false` would under-report permanent failures, which is exactly the signal this
 * metric exists to carry.
 */
export type JobFailureFinality = 'true' | 'false' | 'unknown';

/**
 * prom-client throws on duplicate metric registration. Jest module resets and the
 * API/worker both loading this file make that reachable, so every metric goes
 * through a get-or-create -- the same pattern health.controller.ts uses.
 */
function getOrCreateCounter<TLabel extends string>(
  name: string,
  help: string,
  labelNames: readonly TLabel[],
): Counter<TLabel> {
  const existing = SHARED_METRICS_REGISTRY.getSingleMetric(name);
  if (existing) {
    return existing as Counter<TLabel>;
  }

  return new Counter<TLabel>({
    name,
    help,
    labelNames: [...labelNames],
    registers: [SHARED_METRICS_REGISTRY],
  });
}

const jobsFailedTotal = getOrCreateCounter('rss_jobs_failed_total', 'Total queue job failures by queue and finality', [
  'queue',
  'final',
] as const);

const jobsDeadLetteredTotal = getOrCreateCounter(
  'rss_jobs_dead_lettered_total',
  'Total jobs written to dead_letter_jobs after exhausting every attempt',
  ['queue'] as const,
);

const deadLetterWriteFailuresTotal = getOrCreateCounter(
  'rss_dead_letter_write_failures_total',
  'Total dead letter rows that could NOT be persisted; each one is a permanently failed job with no trace left',
  ['queue'] as const,
);

const feedsReleasedStuckTotal = getOrCreateCounter(
  'rss_feeds_released_stuck_total',
  'Total feeds released by the stuck-claim sweep after a worker died mid-fetch',
  [] as const,
);

/**
 * Queue-side counters.
 *
 * These live outside `MetricsService` on purpose: `MetricsService` depends on
 * `FeedsRepository` (its gauges query the database on scrape), and the worker
 * process must be able to count job failures without that dependency. Both write
 * to `SHARED_METRICS_REGISTRY`, so everything still surfaces on one `/metrics`.
 *
 * CARDINALITY RULE -- do not break it: `queue` only ever takes one of the four
 * fixed queue names (`KnownQueueName`). Never label by feed id, tenant id, job id
 * or error message. `final` is a three-value enum. That keeps this whole file at a
 * bounded 4 x 3 + 4 + 4 + 1 series regardless of traffic.
 */
@Injectable()
export class QueueMetricsService {
  /** One job attempt failed. `final` says whether BullMQ will retry it. */
  incrementJobFailure(queue: KnownQueueName, final: JobFailureFinality): void {
    jobsFailedTotal.inc({ queue, final });
  }

  /** A terminally failed job was durably recorded and is replayable. */
  incrementJobDeadLettered(queue: KnownQueueName): void {
    jobsDeadLetteredTotal.inc({ queue });
  }

  /**
   * The dead letter write itself failed. Alert on this: it means a permanent job
   * failure left no record anywhere once `removeOnFail` evicts it from Redis.
   */
  incrementDeadLetterWriteFailure(queue: KnownQueueName): void {
    deadLetterWriteFailuresTotal.inc({ queue });
  }

  /** Feeds recovered by the stuck-claim sweep. A non-zero rate means workers are dying. */
  incrementFeedsReleasedStuck(count: number): void {
    if (count > 0) {
      feedsReleasedStuckTotal.inc(count);
    }
  }

  /** Test seam: clears every counter this service owns. Never called in production. */
  resetForTesting(): void {
    jobsFailedTotal.reset();
    jobsDeadLetteredTotal.reset();
    deadLetterWriteFailuresTotal.reset();
    feedsReleasedStuckTotal.reset();
  }
}
