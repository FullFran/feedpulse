import { Injectable, NotFoundException } from '@nestjs/common';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class GetFeedUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  async execute(id: number) {
    const feed = await this.feedsRepository.findById(id);

    if (!feed) {
      throw new NotFoundException('feed_not_found');
    }

    return feed;
  }
}
