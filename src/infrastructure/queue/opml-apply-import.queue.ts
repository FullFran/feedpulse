import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

import { AppConfigService } from '../../shared/config/app-config.service';

import { buildQueueJobId } from './job-id';
import {
  OPML_APPLY_IMPORT_QUEUE_NAME,
  OpmlApplyImportJobData,
  OpmlApplyImportQueuePort,
} from './queue.constants';

@Injectable()
export class OpmlApplyImportQueue implements OpmlApplyImportQueuePort, OnApplicationShutdown {
  private readonly queue: Queue<OpmlApplyImportJobData, void, string>;

  private get connection() {
    return { url: this.configService.redisUrl };
  }

  constructor(@Inject(AppConfigService) private readonly configService: AppConfigService) {
    this.queue = new Queue<OpmlApplyImportJobData, void, string>(OPML_APPLY_IMPORT_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 4,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }

  async enqueue(job: OpmlApplyImportJobData): Promise<void> {
    await this.queue.add(OPML_APPLY_IMPORT_QUEUE_NAME, job, {
      jobId: buildQueueJobId('opml-apply', job.importId),
    });
  }

  createWorker(processor: (job: Job<OpmlApplyImportJobData, void, string>) => Promise<void>): Worker<OpmlApplyImportJobData, void, string> {
    return new Worker<OpmlApplyImportJobData, void, string>(
      OPML_APPLY_IMPORT_QUEUE_NAME,
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
