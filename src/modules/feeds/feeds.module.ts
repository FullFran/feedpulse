import { Module } from '@nestjs/common';

import { CheckFeedNowUseCase } from './application/check-feed-now.use-case';
import { DisableFeedUseCase } from './application/disable-feed.use-case';
import { GetFeedUseCase } from './application/get-feed.use-case';
import { ListFeedsUseCase } from './application/list-feeds.use-case';
import { RegisterFeedUseCase } from './application/register-feed.use-case';
import { UpdateFeedUseCase } from './application/update-feed.use-case';
import { FeedsRepository } from './feeds.repository';
import { FeedsController } from './http/feeds.controller';

@Module({
  controllers: [FeedsController],
  providers: [FeedsRepository, RegisterFeedUseCase, ListFeedsUseCase, GetFeedUseCase, UpdateFeedUseCase, DisableFeedUseCase, CheckFeedNowUseCase],
  exports: [FeedsRepository],
})
export class FeedsModule {}
