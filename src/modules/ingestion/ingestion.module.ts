import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../shared/config/app-config.module';
import { AppConfigService } from '../../shared/config/app-config.service';

import { AlertsModule } from '../alerts/alerts.module';
import { EntriesModule } from '../entries/entries.module';
import { FeedsModule } from '../feeds/feeds.module';
import { ObservabilityModule } from '../observability/observability.module';
import { OpmlImportsModule } from '../opml-imports/opml-imports.module';
import { RulesModule } from '../rules/rules.module';

import { ProcessFeedJobUseCase } from './application/process-feed-job.use-case';
import { ScheduleDueFeedsUseCase } from './application/schedule-due-feeds.use-case';
import { FEED_FETCHER } from './domain/feed-fetcher.port';
import { DomainRateLimiter } from './infrastructure/domain-rate-limiter';
import { HttpAgents } from './infrastructure/http-agents';
import { HttpFeedFetcher } from './infrastructure/http-feed.fetcher';
import { SchedulerRunner } from './scheduler.runner';
import { WorkerRunner } from './worker.runner';
import { MetricsService } from '../observability/metrics.service';

@Module({
  imports: [AppConfigModule, FeedsModule, EntriesModule, RulesModule, AlertsModule, ObservabilityModule, OpmlImportsModule],
  providers: [
    ScheduleDueFeedsUseCase,
    ProcessFeedJobUseCase,
    SchedulerRunner,
    WorkerRunner,
    HttpAgents,
    {
      provide: DomainRateLimiter,
      useFactory: (metricsService: MetricsService, configService: AppConfigService) =>
        new DomainRateLimiter(metricsService, {
          requestsPerSecond: configService.rateLimitRequestsPerSecond,
          maxBackoffMs: configService.rateLimitMaxBackoffMs,
          baseBackoffMs: configService.rateLimitBaseBackoffMs,
        }),
      inject: [MetricsService, AppConfigService],
    },
    HttpFeedFetcher,
    {
      provide: FEED_FETCHER,
      useExisting: HttpFeedFetcher,
    },
  ],
  exports: [ScheduleDueFeedsUseCase, ProcessFeedJobUseCase, SchedulerRunner, WorkerRunner, FEED_FETCHER],
})
export class IngestionModule {}
