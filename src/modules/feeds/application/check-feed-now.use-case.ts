import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { FETCH_FEED_QUEUE_TOKEN, FetchFeedQueuePort } from '../../../infrastructure/queue/queue.constants';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class CheckFeedNowUseCase {
  constructor(
    private readonly feedsRepository: FeedsRepository,
    @Inject(FETCH_FEED_QUEUE_TOKEN) private readonly fetchFeedQueue: FetchFeedQueuePort,
  ) {}

  async execute(id: number, tenantId: string): Promise<{ id: number; status: 'queued' }> {
    const feed = await this.feedsRepository.findById(id, tenantId);

    if (!feed) {
      throw new NotFoundException('feed_not_found');
    }

    await this.fetchFeedQueue.enqueue({
      feedId: id,
      queuedAt: new Date().toISOString(),
      attempt: 0,
    });

    return {
      id,
      status: 'queued',
    };
  }
}
