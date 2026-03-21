import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { AppConfigService } from '../../shared/config/app-config.service';

import {
  FETCH_FEED_QUEUE_NAME,
  FetchFeedJobData,
  FetchFeedQueuePort,
} from './queue.constants';
import { buildQueueJobId } from './job-id';

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
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }

  async enqueue(job: FetchFeedJobData): Promise<void> {
    await this.queue.add(FETCH_FEED_QUEUE_NAME, job, {
      jobId: buildQueueJobId('feed', job.feedId),
    });
  }

  createWorker(processor: (job: FetchFeedJobData) => Promise<void>): Worker<FetchFeedJobData, void, string> {
    return new Worker<FetchFeedJobData, void, string>(
      FETCH_FEED_QUEUE_NAME,
      async (job) => processor(job.data),
      {
        connection: this.connection,
        concurrency: this.configService.workerConcurrency,
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
