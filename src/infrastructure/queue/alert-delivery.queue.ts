import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';

import { AppConfigService } from '../../shared/config/app-config.service';

import { ALERT_DELIVERY_QUEUE_NAME, AlertDeliveryJobData, AlertDeliveryQueuePort } from './queue.constants';
import { buildQueueJobId } from './job-id';

@Injectable()
export class AlertDeliveryQueue implements AlertDeliveryQueuePort, OnApplicationShutdown {
  private readonly queue: Queue<AlertDeliveryJobData, void, string>;

  private get connection() {
    return { url: this.configService.redisUrl };
  }

  constructor(@Inject(AppConfigService) private readonly configService: AppConfigService) {
    this.queue = new Queue<AlertDeliveryJobData, void, string>(ALERT_DELIVERY_QUEUE_NAME, {
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

  async enqueue(job: AlertDeliveryJobData): Promise<void> {
    await this.queue.add(ALERT_DELIVERY_QUEUE_NAME, job, {
      jobId: buildQueueJobId('alert', job.alertId),
    });
  }

  createWorker(processor: (job: Job<AlertDeliveryJobData, void, string>) => Promise<void>): Worker<AlertDeliveryJobData, void, string> {
    return new Worker<AlertDeliveryJobData, void, string>(
      ALERT_DELIVERY_QUEUE_NAME,
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
