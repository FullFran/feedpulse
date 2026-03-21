import { Injectable, NotFoundException } from '@nestjs/common';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class UpdateFeedUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  async execute(input: { id: number; status?: 'active' | 'paused' | 'error'; pollIntervalSeconds?: number }) {
    const feed = await this.feedsRepository.update(input);

    if (!feed) {
      throw new NotFoundException('feed_not_found');
    }

    return feed;
  }
}
