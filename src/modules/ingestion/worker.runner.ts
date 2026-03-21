import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Job, Worker } from 'bullmq';

import { AlertDeliveryQueue } from '../../infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../../infrastructure/queue/fetch-feed.queue';
import { AlertDeliveryJobData, FetchFeedJobData } from '../../infrastructure/queue/queue.constants';

import { ProcessAlertDeliveryUseCase } from '../alerts/application/process-alert-delivery.use-case';

import { ProcessFeedJobUseCase } from './application/process-feed-job.use-case';

@Injectable()
export class WorkerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private feedWorker: Worker<FetchFeedJobData> | null = null;
  private alertDeliveryWorker: Worker<AlertDeliveryJobData, void, string> | null = null;

  constructor(
    private readonly fetchFeedQueue: FetchFeedQueue,
    private readonly alertDeliveryQueue: AlertDeliveryQueue,
    private readonly processFeedJobUseCase: ProcessFeedJobUseCase,
    private readonly processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase,
  ) {}

  async start(): Promise<void> {
    this.feedWorker = this.fetchFeedQueue.createWorker(async (job) => {
      const result = await this.processFeedJobUseCase.execute(job);
      this.logger.log(`Processed feed ${job.feedId} with ${result.insertedEntries} new entries`);
    });

    this.feedWorker.on('failed', (job, error) => {
      this.logger.error(`Feed job ${job?.data.feedId ?? 'unknown'} failed: ${error.message}`);
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
      this.logger.error(`Alert delivery job ${job?.data.alertId ?? 'unknown'} failed: ${error.message}`);
    });

    this.alertDeliveryWorker.on('error', (error) => {
      this.logger.error(`Alert delivery worker error: ${error.message}`);
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
  }
}
