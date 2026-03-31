import { Injectable, NotFoundException } from '@nestjs/common';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class DisableFeedUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  async execute(id: number, tenantId: string): Promise<void> {
    const disabled = await this.feedsRepository.disable(id, tenantId);

    if (!disabled) {
      throw new NotFoundException('feed_not_found');
    }
  }
}
