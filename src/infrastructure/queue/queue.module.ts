import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import IORedis from 'ioredis';
import { AppConfigModule } from '../../shared/config/app-config.module';
import { AppConfigService } from '../../shared/config/app-config.service';
import { AlertDeliveryQueue } from './alert-delivery.queue';
import { FetchFeedQueue } from './fetch-feed.queue';
import { OpmlApplyImportQueue } from './opml-apply-import.queue';
import { OpmlParsePreviewQueue } from './opml-parse-preview.queue';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  FETCH_FEED_QUEUE_TOKEN,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  REDIS_CONNECTION,
} from './queue.constants';

/**
 * The shared connection every BullMQ queue and worker rides on.
 *
 * Nest only invokes lifecycle hooks on the object a factory returns, and an
 * `IORedis` instance has none of its own. Without this hook the socket outlives
 * `app.close()` and keeps the event loop alive indefinitely, so every SIGTERM
 * ended at the `SHUTDOWN_TIMEOUT_MS` force-exit deadline with exit code 1 —
 * which an orchestrator reads as a crashed container on every rolling restart.
 */
function createRedisConnection(redisUrl: string): IORedis & OnApplicationShutdown {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  return Object.assign(connection, {
    async onApplicationShutdown(): Promise<void> {
      try {
        await connection.quit();
      } catch {
        // `quit` rejects when the connection is already gone or mid-reconnect;
        // tear the socket down regardless so the process can exit.
        connection.disconnect();
      }
    },
  });
}

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [AppConfigService],
      useFactory: (configService: AppConfigService) => createRedisConnection(configService.redisUrl),
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
