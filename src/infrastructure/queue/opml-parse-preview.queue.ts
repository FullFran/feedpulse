import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

import { AppConfigService } from '../../shared/config/app-config.service';

import { buildQueueJobId } from './job-id';
import {
  OPML_PARSE_PREVIEW_QUEUE_NAME,
  OpmlParsePreviewJobData,
  OpmlParsePreviewQueuePort,
} from './queue.constants';

@Injectable()
export class OpmlParsePreviewQueue implements OpmlParsePreviewQueuePort, OnApplicationShutdown {
  private readonly queue: Queue<OpmlParsePreviewJobData, void, string>;

  private get connection() {
    return { url: this.configService.redisUrl };
  }

  constructor(@Inject(AppConfigService) private readonly configService: AppConfigService) {
    this.queue = new Queue<OpmlParsePreviewJobData, void, string>(OPML_PARSE_PREVIEW_QUEUE_NAME, {
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

  async enqueue(job: OpmlParsePreviewJobData): Promise<void> {
    await this.queue.add(OPML_PARSE_PREVIEW_QUEUE_NAME, job, {
      jobId: buildQueueJobId('opml-parse', job.importId),
    });
  }

  createWorker(processor: (job: Job<OpmlParsePreviewJobData, void, string>) => Promise<void>): Worker<OpmlParsePreviewJobData, void, string> {
    return new Worker<OpmlParsePreviewJobData, void, string>(
      OPML_PARSE_PREVIEW_QUEUE_NAME,
      async (job) => processor(job),
      {
        connection: this.connection,
        concurrency: Math.max(1, Math.min(this.configService.workerConcurrency, 3)),
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
