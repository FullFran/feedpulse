import { Injectable } from '@nestjs/common';

import { Feed } from '../domain/feed.entity';
import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class RegisterFeedUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  async execute(input: {
    tenantId: string;
    url: string;
    pollIntervalSeconds?: number;
    status?: 'active' | 'paused' | 'error';
  }): Promise<Feed> {
    return this.feedsRepository.create({
      tenantId: input.tenantId,
      url: input.url,
      pollIntervalSeconds: input.pollIntervalSeconds ?? 1800,
      status: input.status ?? 'active',
    });
  }
}
