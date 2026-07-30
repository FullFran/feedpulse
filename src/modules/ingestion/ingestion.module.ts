import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../shared/config/app-config.module';
import { AppConfigService } from '../../shared/config/app-config.service';
import { AlertsModule } from '../alerts/alerts.module';
import { EntriesModule } from '../entries/entries.module';
import { FeedsModule } from '../feeds/feeds.module';
import { MetricsService } from '../observability/metrics.service';
import { ObservabilityModule } from '../observability/observability.module';
import { OpmlImportsModule } from '../opml-imports/opml-imports.module';
import { RulesModule } from '../rules/rules.module';
import { ProcessFeedJobUseCase } from './application/process-feed-job.use-case';
import { ReleaseStuckFeedsUseCase } from './application/release-stuck-feeds.use-case';
import { ScheduleDueFeedsUseCase } from './application/schedule-due-feeds.use-case';
import { FEED_FETCHER } from './domain/feed-fetcher.port';
import { DomainRateLimiter } from './infrastructure/domain-rate-limiter';
import { HttpFeedFetcher } from './infrastructure/http-feed.fetcher';
import { SchedulerRunner } from './scheduler.runner';
import { WorkerRunner } from './worker.runner';

@Module({
  imports: [
    AppConfigModule,
    FeedsModule,
    EntriesModule,
    RulesModule,
    AlertsModule,
    ObservabilityModule,
    OpmlImportsModule,
  ],
  providers: [
    ScheduleDueFeedsUseCase,
    ReleaseStuckFeedsUseCase,
    ProcessFeedJobUseCase,
    SchedulerRunner,
    WorkerRunner,
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
  exports: [
    ScheduleDueFeedsUseCase,
    ReleaseStuckFeedsUseCase,
    ProcessFeedJobUseCase,
    SchedulerRunner,
    WorkerRunner,
    FEED_FETCHER,
  ],
})
export class IngestionModule {}
