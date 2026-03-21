import { Injectable, NotFoundException } from '@nestjs/common';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class DisableFeedUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  async execute(id: number): Promise<void> {
    const disabled = await this.feedsRepository.disable(id);

    if (!disabled) {
      throw new NotFoundException('feed_not_found');
    }
  }
}
