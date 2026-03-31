import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Job, Worker } from 'bullmq';

import { AlertDeliveryQueue } from '../../infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../../infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../../infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../../infrastructure/queue/opml-parse-preview.queue';
import { AlertDeliveryJobData, FetchFeedJobData, OpmlApplyImportJobData, OpmlParsePreviewJobData } from '../../infrastructure/queue/queue.constants';

import { ProcessAlertDeliveryUseCase } from '../alerts/application/process-alert-delivery.use-case';
import { ProcessOpmlApplyJobUseCase } from '../opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../opml-imports/application/process-opml-parse-job.use-case';

import { ProcessFeedJobUseCase } from './application/process-feed-job.use-case';

@Injectable()
export class WorkerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRunner.name);
  private feedWorker: Worker<FetchFeedJobData> | null = null;
  private alertDeliveryWorker: Worker<AlertDeliveryJobData, void, string> | null = null;
  private opmlParseWorker: Worker<OpmlParsePreviewJobData, void, string> | null = null;
  private opmlApplyWorker: Worker<OpmlApplyImportJobData, void, string> | null = null;

  constructor(
    private readonly fetchFeedQueue: FetchFeedQueue,
    private readonly alertDeliveryQueue: AlertDeliveryQueue,
    private readonly opmlParsePreviewQueue: OpmlParsePreviewQueue,
    private readonly opmlApplyImportQueue: OpmlApplyImportQueue,
    private readonly processFeedJobUseCase: ProcessFeedJobUseCase,
    private readonly processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase,
    private readonly processOpmlParseJobUseCase: ProcessOpmlParseJobUseCase,
    private readonly processOpmlApplyJobUseCase: ProcessOpmlApplyJobUseCase,
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

    this.opmlParseWorker = this.opmlParsePreviewQueue.createWorker(async (job) => {
      await this.processOpmlParseJobUseCase.execute(job.data);
    });

    this.opmlParseWorker.on('failed', (job, error) => {
      this.logger.error(`OPML parse job ${job?.data.importId ?? 'unknown'} failed: ${error.message}`);
    });

    this.opmlParseWorker.on('error', (error) => {
      this.logger.error(`OPML parse worker error: ${error.message}`);
    });

    this.opmlApplyWorker = this.opmlApplyImportQueue.createWorker(async (job) => {
      await this.processOpmlApplyJobUseCase.execute(job.data);
    });

    this.opmlApplyWorker.on('failed', (job, error) => {
      this.logger.error(`OPML apply job ${job?.data.importId ?? 'unknown'} failed: ${error.message}`);
    });

    this.opmlApplyWorker.on('error', (error) => {
      this.logger.error(`OPML apply worker error: ${error.message}`);
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
  }
}
