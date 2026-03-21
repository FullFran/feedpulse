import { Global, Module } from '@nestjs/common';
import IORedis from 'ioredis';

import { AppConfigModule } from '../../shared/config/app-config.module';
import { AppConfigService } from '../../shared/config/app-config.service';

import { AlertDeliveryQueue } from './alert-delivery.queue';

import { FetchFeedQueue } from './fetch-feed.queue';
import { ALERT_DELIVERY_QUEUE_TOKEN, FETCH_FEED_QUEUE_TOKEN, REDIS_CONNECTION } from './queue.constants';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [AppConfigService],
      useFactory: (configService: AppConfigService) => new IORedis(configService.redisUrl, { maxRetriesPerRequest: null }),
    },
    AlertDeliveryQueue,
    FetchFeedQueue,
    {
      provide: ALERT_DELIVERY_QUEUE_TOKEN,
      useExisting: AlertDeliveryQueue,
    },
    {
      provide: FETCH_FEED_QUEUE_TOKEN,
      useExisting: FetchFeedQueue,
    },
  ],
  exports: [REDIS_CONNECTION, AlertDeliveryQueue, FetchFeedQueue, ALERT_DELIVERY_QUEUE_TOKEN, FETCH_FEED_QUEUE_TOKEN],
})
export class QueueModule {}
