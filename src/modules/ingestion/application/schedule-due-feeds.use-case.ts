import { Inject, Injectable } from '@nestjs/common';
import { ReadinessService } from '../../../infrastructure/persistence/readiness.service';
import { FETCH_FEED_QUEUE_TOKEN, FetchFeedQueuePort } from '../../../infrastructure/queue/queue.constants';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { FeedsRepository } from '../../feeds/feeds.repository';

@Injectable()
export class ScheduleDueFeedsUseCase {
  constructor(
    private readonly readinessService: ReadinessService,
    private readonly feedsRepository: FeedsRepository,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
    @Inject(FETCH_FEED_QUEUE_TOKEN) private readonly fetchFeedQueue: FetchFeedQueuePort,
  ) {}

  async execute(): Promise<{ scheduled: number; deduplicated: number }> {
    await this.readinessService.assertSchemaReady();
    const feeds = await this.feedsRepository.claimDueFeeds(this.appConfigService.schedulerBatchSize);
    const queuedAt = new Date().toISOString();

    const results = await Promise.all(
      feeds.map((feed) =>
        this.fetchFeedQueue.enqueue({
          feedId: feed.id,
          queuedAt,
          attempt: 1,
          source: 'scheduler',
        }),
      ),
    );

    // A deduplicated enqueue means an earlier job for the same feed is still queued, so the
    // claim we just took will not be released by a worker. The stuck feed sweep recovers it.
    const deduplicated = results.filter((result) => result.deduplicated).length;

    return { scheduled: feeds.length - deduplicated, deduplicated };
  }
}
