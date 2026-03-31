import { Global, Module } from '@nestjs/common';
import IORedis from 'ioredis';

import { AppConfigModule } from '../../shared/config/app-config.module';
import { AppConfigService } from '../../shared/config/app-config.service';

import { AlertDeliveryQueue } from './alert-delivery.queue';
import { OpmlApplyImportQueue } from './opml-apply-import.queue';
import { OpmlParsePreviewQueue } from './opml-parse-preview.queue';

import { FetchFeedQueue } from './fetch-feed.queue';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  FETCH_FEED_QUEUE_TOKEN,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  REDIS_CONNECTION,
} from './queue.constants';

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
    OpmlParsePreviewQueue,
    OpmlApplyImportQueue,
    {
      provide: ALERT_DELIVERY_QUEUE_TOKEN,
      useExisting: AlertDeliveryQueue,
    },
    {
      provide: FETCH_FEED_QUEUE_TOKEN,
      useExisting: FetchFeedQueue,
    },
    {
      provide: OPML_PARSE_PREVIEW_QUEUE_TOKEN,
      useExisting: OpmlParsePreviewQueue,
    },
    {
      provide: OPML_APPLY_IMPORT_QUEUE_TOKEN,
      useExisting: OpmlApplyImportQueue,
    },
  ],
  exports: [
    REDIS_CONNECTION,
    AlertDeliveryQueue,
    FetchFeedQueue,
    OpmlParsePreviewQueue,
    OpmlApplyImportQueue,
    ALERT_DELIVERY_QUEUE_TOKEN,
    FETCH_FEED_QUEUE_TOKEN,
    OPML_PARSE_PREVIEW_QUEUE_TOKEN,
    OPML_APPLY_IMPORT_QUEUE_TOKEN,
  ],
})
export class QueueModule {}
