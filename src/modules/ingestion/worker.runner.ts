import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import { AlertDeliveryQueue } from '../../infrastructure/queue/alert-delivery.queue';
import type { KnownQueueName } from '../../infrastructure/queue/dead-letter.repository';
import { DeadLetterRepository } from '../../infrastructure/queue/dead-letter.repository';
import { FetchFeedQueue } from '../../infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../../infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../../infrastructure/queue/opml-parse-preview.queue';
import {
  ALERT_DELIVERY_QUEUE_NAME,
  AlertDeliveryJobData,
  FETCH_FEED_QUEUE_NAME,
  FetchFeedJobData,
  OPML_APPLY_IMPORT_QUEUE_NAME,
  OPML_PARSE_PREVIEW_QUEUE_NAME,
  OpmlApplyImportJobData,
  OpmlParsePreviewJobData,
} from '../../infrastructure/queue/queue.constants';
import { ProcessAlertDeliveryUseCase } from '../alerts/application/process-alert-delivery.use-case';
import type { JobFailureFinality } from '../observability/queue-metrics.service';
import { QueueMetricsService } from '../observability/queue-metrics.service';
import { ProcessOpmlApplyJobUseCase } from '../opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../opml-imports/application/process-opml-parse-job.use-case';
import { ProcessFeedJobUseCase } from './application/process-feed-job.use-case';

/** The minimum shape `classifyAttempt` needs, so it stays testable without BullMQ. */
export interface AttemptBearingJob {
  readonly attemptsMade: number;
  readonly opts?: { readonly attempts?: number };
}

export interface AttemptClassification {
  readonly finality: JobFailureFinality;
  readonly attemptsMade: number;
  readonly maxAttempts: number;
}

/**
 * Decides whether a `failed` event was the job's last attempt.
 *
 * In BullMQ, `attemptsMade` inside a `failed` handler already counts the attempt
 * that just failed, so a job is terminal once it reaches the configured
 * `opts.attempts`. `attempts` defaults to 1 when unset, matching BullMQ's own
 * default of "run once, never retry".
 *
 * An undefined job (evicted from Redis, or a lost lock) is classified `unknown`
 * rather than `false`: reporting a possibly permanent failure as retryable is the
 * one error mode these metrics must not have.
 */
export function classifyAttempt(job: AttemptBearingJob | undefined): AttemptClassification {
  if (!job) {
    return { finality: 'unknown', attemptsMade: 0, maxAttempts: 0 };
  }

  const maxAttempts = job.opts?.attempts ?? 1;
  const attemptsMade = job.attemptsMade;

  return { finality: attemptsMade >= maxAttempts ? 'true' : 'false', attemptsMade, maxAttempts };
}

@Injectable()
export class WorkerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private feedWorker: Worker<FetchFeedJobData> | null = null;
  private alertDeliveryWorker: Worker<AlertDeliveryJobData, void, string> | null = null;
  private opmlParseWorker: Worker<OpmlParsePreviewJobData, void, string> | null = null;
  private opmlApplyWorker: Worker<OpmlApplyImportJobData, void, string> | null = null;

  /**
   * Dead-letter writes started from a `failed` event. BullMQ's event emitter is
   * synchronous, so the write cannot be awaited there; shutdown drains this set
   * instead, otherwise a SIGTERM during a burst of terminal failures loses exactly
   * the records that would have explained the outage.
   */
  private readonly pendingDeadLetterWrites = new Set<Promise<void>>();

  constructor(
    private readonly fetchFeedQueue: FetchFeedQueue,
    private readonly alertDeliveryQueue: AlertDeliveryQueue,
    private readonly opmlParsePreviewQueue: OpmlParsePreviewQueue,
    private readonly opmlApplyImportQueue: OpmlApplyImportQueue,
    private readonly processFeedJobUseCase: ProcessFeedJobUseCase,
    private readonly processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase,
    private readonly processOpmlParseJobUseCase: ProcessOpmlParseJobUseCase,
    private readonly processOpmlApplyJobUseCase: ProcessOpmlApplyJobUseCase,
    private readonly deadLetterRepository: DeadLetterRepository,
    private readonly queueMetrics: QueueMetricsService,
  ) {}

  /**
   * Registers the four BullMQ workers and their event handlers.
   *
   * Deliberately not `async`: worker registration is entirely synchronous, so
   * `async` would advertise asynchronous work that never happens. The
   * `Promise<void>` return type is kept because every caller awaits it
   * (`src/main/worker.ts`, and the release-stuck-feeds suite asserts
   * `resolves.toBeUndefined()`).
   */
  start(): Promise<void> {
    // The processor receives the full BullMQ Job (not just `job.data`) so long-running feed
    // jobs keep access to `job.extendLock()` and to the attempt metadata.
    this.feedWorker = this.fetchFeedQueue.createWorker(async (job) => {
      const result = await this.processFeedJobUseCase.execute(job.data);
      this.logger.log(`Processed feed ${job.data.feedId} with ${result.insertedEntries} new entries`);
    });

    this.feedWorker.on('failed', (job, error) => {
      this.trackFailure(
        this.handleJobFailure({
          queue: FETCH_FEED_QUEUE_NAME,
          subject: `Feed job ${job?.data.feedId ?? 'unknown'}`,
          job,
          error,
        }),
      );
    });

    this.feedWorker.on('error', (error) => {
      this.logger.error(`Worker error: ${error.message}`);
    });

    this.alertDeliveryWorker = this.alertDeliveryQueue.createWorker(async (job) => {
      await this.processAlertDeliveryUseCase.execute({
        alertId: job.data.alertId,
        attemptNumber: job.attemptsMade + 1,
        willRetry: job.attemptsMade + 1 < (job.opts.attempts ?? 1),
      });
    });

    this.alertDeliveryWorker.on('failed', (job, error) => {
      this.trackFailure(
        this.handleJobFailure({
          queue: ALERT_DELIVERY_QUEUE_NAME,
          subject: `Alert delivery job ${job?.data.alertId ?? 'unknown'}`,
          job,
          error,
        }),
      );
    });

    this.alertDeliveryWorker.on('error', (error) => {
      this.logger.error(`Alert delivery worker error: ${error.message}`);
    });

    this.opmlParseWorker = this.opmlParsePreviewQueue.createWorker(async (job) => {
      await this.processOpmlParseJobUseCase.execute(job.data);
    });

    this.opmlParseWorker.on('failed', (job, error) => {
      this.trackFailure(
        this.handleJobFailure({
          queue: OPML_PARSE_PREVIEW_QUEUE_NAME,
          subject: `OPML parse job ${job?.data.importId ?? 'unknown'}`,
          job,
          error,
        }),
      );
    });

    this.opmlParseWorker.on('error', (error) => {
      this.logger.error(`OPML parse worker error: ${error.message}`);
    });

    this.opmlApplyWorker = this.opmlApplyImportQueue.createWorker(async (job) => {
      await this.processOpmlApplyJobUseCase.execute(job.data);
    });

    this.opmlApplyWorker.on('failed', (job, error) => {
      this.trackFailure(
        this.handleJobFailure({
          queue: OPML_APPLY_IMPORT_QUEUE_NAME,
          subject: `OPML apply job ${job?.data.importId ?? 'unknown'}`,
          job,
          error,
        }),
      );
    });

    this.opmlApplyWorker.on('error', (error) => {
      this.logger.error(`OPML apply worker error: ${error.message}`);
    });

    return Promise.resolve();
  }

  /**
   * Handles one `failed` event: classify it, count it, log it at the severity it
   * actually deserves, and dead-letter it when nothing else is going to retry it.
   *
   * Never rejects. It is driven from an event handler, where a rejection becomes an
   * unhandled rejection and takes the worker process down on Node >= 15.
   */
  async handleJobFailure<TData>(params: {
    queue: KnownQueueName;
    subject: string;
    job: Job<TData> | undefined;
    error: Error;
  }): Promise<void> {
    const { queue, subject, job, error } = params;
    const { finality, attemptsMade, maxAttempts } = classifyAttempt(job);

    this.queueMetrics.incrementJobFailure(queue, finality);

    if (finality === 'false') {
      // A retryable attempt is expected operation, not an incident. Logging every
      // one of them at `error` is what used to bury the few that were terminal.
      this.logger.warn(`${subject} failed on attempt ${attemptsMade}/${maxAttempts}, will retry: ${error.message}`);
      return;
    }

    if (finality === 'unknown' || !job) {
      this.logger.error(
        `${subject} failed but BullMQ reported no job, so it cannot be dead-lettered: ${error.message}`,
      );
      return;
    }

    this.logger.error(`${subject} failed permanently after ${attemptsMade}/${maxAttempts} attempts: ${error.message}`);

    try {
      await this.deadLetterRepository.record({
        queue,
        jobId: job.id ?? 'unknown',
        payload: job.data,
        error: error.message,
        attempts: attemptsMade,
      });
      this.queueMetrics.incrementJobDeadLettered(queue);
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : 'Unknown dead letter write failure';
      this.queueMetrics.incrementDeadLetterWriteFailure(queue);
      this.logger.error(`Failed to dead-letter ${subject} on queue ${queue}: ${message}`);
    }
  }

  /** Keeps a fire-and-forget failure handler awaitable by shutdown. */
  private trackFailure(pending: Promise<void>): void {
    this.pendingDeadLetterWrites.add(pending);
    void pending.finally(() => {
      this.pendingDeadLetterWrites.delete(pending);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.feedWorker) {
      await this.feedWorker.close();
      this.feedWorker = null;
    }

    if (this.alertDeliveryWorker) {
      await this.alertDeliveryWorker.close();
      this.alertDeliveryWorker = null;
    }

    if (this.opmlParseWorker) {
      await this.opmlParseWorker.close();
      this.opmlParseWorker = null;
    }

    if (this.opmlApplyWorker) {
      await this.opmlApplyWorker.close();
      this.opmlApplyWorker = null;
    }

    // Workers close first so no new failures can arrive, then the writes already in
    // flight are drained. `handleJobFailure` never rejects, so this cannot throw.
    await Promise.all([...this.pendingDeadLetterWrites]);
  }
}
