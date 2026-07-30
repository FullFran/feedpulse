import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FETCH_FEED_QUEUE_TOKEN, FetchFeedQueuePort } from '../../../infrastructure/queue/queue.constants';
import { FeedsRepository } from '../feeds.repository';

export type CheckFeedNowStatus = 'queued' | 'already_queued';

export interface CheckFeedNowResult {
  id: number;
  status: CheckFeedNowStatus;
}

@Injectable()
export class CheckFeedNowUseCase {
  constructor(
    private readonly feedsRepository: FeedsRepository,
    @Inject(FETCH_FEED_QUEUE_TOKEN) private readonly fetchFeedQueue: FetchFeedQueuePort,
  ) {}

  async execute(id: number, tenantId: string): Promise<CheckFeedNowResult> {
    const feed = await this.feedsRepository.findById(id, tenantId);

    if (!feed) {
      throw new NotFoundException('feed_not_found');
    }

    // Manual checks escape scheduler deduplication by carrying a unique job id, so the claim
    // marker is what stops an operator from stacking fetches on a feed already being fetched.
    // A crashed worker holds that claim for at most SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS.
    if (await this.feedsRepository.isClaimed(id, tenantId)) {
      return { id, status: 'already_queued' };
    }

    const enqueued = await this.fetchFeedQueue.enqueue({
      feedId: id,
      queuedAt: new Date().toISOString(),
      attempt: 0,
      source: 'manual',
    });

    return {
      id,
      status: enqueued.deduplicated ? 'already_queued' : 'queued',
    };
  }
}
