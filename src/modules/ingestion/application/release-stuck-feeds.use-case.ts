import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ReadinessService } from '../../../infrastructure/persistence/readiness.service';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { FeedsRepository } from '../../feeds/feeds.repository';
import { QueueMetricsService } from '../../observability/queue-metrics.service';

/**
 * Fallback used when SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS is missing or nonsensical.
 * Matches the documented env default and stays above the worst-case job duration
 * (RATE_LIMIT_MAX_BACKOFF_MS 60s + FETCH_TIMEOUT_MS 10s).
 */
export const DEFAULT_STUCK_FEED_THRESHOLD_SECONDS = 300;

/**
 * The slice of the application configuration this use case depends on. Declaring it as a
 * narrow contract keeps the dependency explicit and lets the use case be exercised without
 * building the whole config tree.
 */
export interface StuckFeedSweepConfig {
  readonly schedulerStuckFeedThresholdSeconds: number;
}

/**
 * Recovers feeds whose scheduler claim was never released.
 *
 * `claimDueFeeds` pushes `next_check_at` into the future before the fetch runs, so a worker
 * that crashes, is OOM-killed, or throws before `updateAfterFetch` would otherwise leave the
 * feed dark for a whole poll interval with no operator signal. This sweep runs first on every
 * scheduler tick and makes those feeds due again.
 */
@Injectable()
export class ReleaseStuckFeedsUseCase {
  private readonly logger = new Logger(ReleaseStuckFeedsUseCase.name);

  constructor(
    private readonly readinessService: ReadinessService,
    private readonly feedsRepository: FeedsRepository,
    @Inject(AppConfigService) private readonly sweepConfig: StuckFeedSweepConfig,
    /**
     * Optional so the existing three-argument construction in tests keeps working.
     * Nest always injects it: `IngestionModule` imports `ObservabilityModule`.
     */
    @Optional() private readonly queueMetrics?: QueueMetricsService,
  ) {}

  async execute(): Promise<{ released: number }> {
    await this.readinessService.assertSchemaReady();

    const released = await this.feedsRepository.releaseStuckFeeds(this.resolveThresholdSeconds());

    if (released > 0) {
      // A log line is not alertable. A worker that OOMs every few minutes shows up
      // here as a steady rate on rss_feeds_released_stuck_total long before anyone
      // notices feeds going quiet.
      this.queueMetrics?.incrementFeedsReleasedStuck(released);
      this.logger.warn(`Released ${released} stuck feed(s) past the claim threshold`);
    }

    return { released };
  }

  private resolveThresholdSeconds(): number {
    const configured = this.sweepConfig.schedulerStuckFeedThresholdSeconds;

    // A threshold below the worst-case job duration would release feeds that are still
    // being fetched and cause duplicate requests, so refuse anything non-positive.
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STUCK_FEED_THRESHOLD_SECONDS;
  }
}
