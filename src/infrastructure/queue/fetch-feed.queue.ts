import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { AppConfigService } from '../../shared/config/app-config.service';
import { buildQueueJobId } from './job-id';
import { FETCH_FEED_QUEUE_NAME, FetchFeedEnqueueResult, FetchFeedJobData, FetchFeedQueuePort } from './queue.constants';

/**
 * Safety margin on top of the worst-case job duration, so a job that legitimately runs to
 * the wire is never declared stalled because of clock skew or event-loop pressure.
 */
const WORKER_LOCK_MARGIN_MS = 30_000;

@Injectable()
export class FetchFeedQueue implements FetchFeedQueuePort, OnApplicationShutdown {
  private readonly queue: Queue<FetchFeedJobData, void, string>;

  private get connection() {
    return { url: this.configService.redisUrl };
  }

  constructor(@Inject(AppConfigService) private readonly configService: AppConfigService) {
    this.queue = new Queue<FetchFeedJobData, void, string>(FETCH_FEED_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        // Deterministic jobId (`feed-<id>`) collides with retained completed jobs:
        // re-enqueue becomes a silent no-op, leaving feeds stuck until retention evicts the old job.
        removeOnComplete: true,
        removeOnFail: 100,
      },
    });
  }

  async enqueue(job: FetchFeedJobData): Promise<FetchFeedEnqueueResult> {
    const jobId = this.buildJobId(job);

    // Manual checks carry a unique id, so there is nothing to deduplicate against and the
    // extra Redis round-trip would be pure overhead.
    if (job.source !== 'manual') {
      const existing = await this.queue.getJob(jobId);

      if (existing) {
        return { jobId, deduplicated: true };
      }
    }

    await this.queue.add(FETCH_FEED_QUEUE_NAME, job, { jobId });

    return { jobId, deduplicated: false };
  }

  private buildJobId(job: FetchFeedJobData): string {
    return job.source === 'manual'
      ? buildQueueJobId('feed', `${job.feedId}-manual-${Date.now()}`)
      : buildQueueJobId('feed', job.feedId);
  }

  createWorker(
    processor: (job: Job<FetchFeedJobData, void, string>) => Promise<void>,
  ): Worker<FetchFeedJobData, void, string> {
    return new Worker<FetchFeedJobData, void, string>(FETCH_FEED_QUEUE_NAME, async (job) => processor(job), {
      connection: this.connection,
      concurrency: this.configService.workerConcurrency,
      lockDuration: this.resolveLockDuration(),
    });
  }

  /**
   * BullMQ's default lock duration is 30s, but a feed job can legitimately block for
   * RATE_LIMIT_MAX_BACKOFF_MS inside DomainRateLimiter.waitForSlot and then another
   * FETCH_TIMEOUT_MS on the wire. With the default lock the stalled-job checker requeues a
   * job that is still running: a second worker re-fetches a host that just answered 429 and
   * the job eventually dies with a misleading "stalled more than allowable limit".
   *
   * This value is therefore coupled to both timeouts; raising either of them without
   * raising this reintroduces the bug.
   *
   * NOTE: DomainRateLimiter keeps its per-domain state in process-local Maps, so N worker
   * replicas apply N x the configured rate against the same host. A Redis-backed limiter is
   * the real fix; REDIS_CONNECTION is already exported from QueueModule for that purpose.
   */
  private resolveLockDuration(): number {
    return this.configService.rateLimitMaxBackoffMs + this.configService.fetchTimeoutMs + WORKER_LOCK_MARGIN_MS;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
