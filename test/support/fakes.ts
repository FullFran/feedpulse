import type { TestingModuleBuilder } from '@nestjs/testing';
import { AlertDeliveryQueue } from '../../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../../src/infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../../src/infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../../src/infrastructure/queue/opml-parse-preview.queue';
import type {
  AlertDeliveryJobData,
  FetchFeedEnqueueResult,
  FetchFeedJobData,
  OpmlApplyImportJobData,
  OpmlParsePreviewJobData,
} from '../../src/infrastructure/queue/queue.constants';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  FETCH_FEED_QUEUE_TOKEN,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  REDIS_CONNECTION,
} from '../../src/infrastructure/queue/queue.constants';
import type { FeedFetchResult } from '../../src/modules/ingestion/domain/feed-fetcher.port';
import type {
  AlertNotificationPayload,
  AlertNotifierPort,
  TelegramDigestPayload,
} from '../../src/modules/notifications/domain/alert-notifier.port';

/**
 * One copy of each test double.
 *
 * Six suites used to declare their own `FakeQueue`/`FakeRedis`/notifier, and
 * they had already fallen out of step: the notifier in one of them predated
 * `sendTelegramDigest`, so a port method could be added and every test would
 * still pass while silently doing nothing. Implementing `AlertNotifierPort`
 * here, once, makes that a compile error instead.
 */

/**
 * Health check plus the small counter surface `EmailRateLimitService` needs.
 *
 * The counter methods are not decoration: without them the service hits a
 * TypeError on every `reserve()` and fails open, so the per-tenant email quota
 * would be silently inert in every container-backed suite — the exact opposite
 * of what those suites are meant to prove. `expire` is a no-op because nothing
 * in the test suite advances far enough for a TTL to matter, and there is
 * deliberately no `eval`: `createRateLimitStore` probes for it, and the inbound
 * rate limiter is expected to fall back to its per-process store under test.
 */
export class FakeRedis {
  private readonly values = new Map<string, number>();

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<void> {
    return undefined;
  }

  async get(key: string): Promise<string | null> {
    const value = this.values.get(key);

    return value === undefined ? null : String(value);
  }

  async incr(key: string): Promise<number> {
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);

    return next;
  }

  async decr(key: string): Promise<number> {
    const next = (this.values.get(key) ?? 0) - 1;
    this.values.set(key, next);

    return next;
  }

  async expire(): Promise<number> {
    return 1;
  }

  /** Test seam: drops every counter. */
  reset(): void {
    this.values.clear();
  }
}

/** Common shape: record what was enqueued, refuse to pretend to be a worker. */
abstract class RecordingQueue<TJob> {
  readonly jobs: TJob[] = [];

  reset(): void {
    this.jobs.length = 0;
  }

  createWorker(): never {
    throw new Error('fake_queue_cannot_create_workers');
  }
}

export class FakeFetchFeedQueue extends RecordingQueue<FetchFeedJobData> {
  async enqueue(job: FetchFeedJobData): Promise<FetchFeedEnqueueResult> {
    this.jobs.push(job);

    return { jobId: `feed-${job.feedId}`, deduplicated: false };
  }
}

export class FakeAlertDeliveryQueue extends RecordingQueue<AlertDeliveryJobData> {
  async enqueue(job: AlertDeliveryJobData): Promise<void> {
    this.jobs.push(job);
  }
}

export class FakeOpmlParsePreviewQueue extends RecordingQueue<OpmlParsePreviewJobData> {
  async enqueue(job: OpmlParsePreviewJobData): Promise<void> {
    this.jobs.push(job);
  }
}

export class FakeOpmlApplyImportQueue extends RecordingQueue<OpmlApplyImportJobData> {
  async enqueue(job: OpmlApplyImportJobData): Promise<void> {
    this.jobs.push(job);
  }
}

export interface FakeQueues {
  readonly fetchFeed: FakeFetchFeedQueue;
  readonly alertDelivery: FakeAlertDeliveryQueue;
  readonly opmlParse: FakeOpmlParsePreviewQueue;
  readonly opmlApply: FakeOpmlApplyImportQueue;
}

export function createFakeQueues(): FakeQueues {
  return {
    fetchFeed: new FakeFetchFeedQueue(),
    alertDelivery: new FakeAlertDeliveryQueue(),
    opmlParse: new FakeOpmlParsePreviewQueue(),
    opmlApply: new FakeOpmlApplyImportQueue(),
  };
}

export function resetFakeQueues(queues: FakeQueues): void {
  queues.fetchFeed.reset();
  queues.alertDelivery.reset();
  queues.opmlParse.reset();
  queues.opmlApply.reset();
}

/**
 * Replaces every queue provider plus the Redis connection in one call.
 *
 * Each queue is registered twice in the container (under its injection token and
 * under its concrete class), so overriding only one of the two leaves a real
 * BullMQ queue wired somewhere and the suite opens a socket to a Redis that is
 * not there.
 */
export function overrideQueueProviders(builder: TestingModuleBuilder, queues: FakeQueues): TestingModuleBuilder {
  return builder
    .overrideProvider(REDIS_CONNECTION)
    .useValue(new FakeRedis())
    .overrideProvider(FETCH_FEED_QUEUE_TOKEN)
    .useValue(queues.fetchFeed)
    .overrideProvider(FetchFeedQueue)
    .useValue(queues.fetchFeed)
    .overrideProvider(ALERT_DELIVERY_QUEUE_TOKEN)
    .useValue(queues.alertDelivery)
    .overrideProvider(AlertDeliveryQueue)
    .useValue(queues.alertDelivery)
    .overrideProvider(OPML_PARSE_PREVIEW_QUEUE_TOKEN)
    .useValue(queues.opmlParse)
    .overrideProvider(OpmlParsePreviewQueue)
    .useValue(queues.opmlParse)
    .overrideProvider(OPML_APPLY_IMPORT_QUEUE_TOKEN)
    .useValue(queues.opmlApply)
    .overrideProvider(OpmlApplyImportQueue)
    .useValue(queues.opmlApply);
}

const DEFAULT_FEED_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>AI launch update</title>
      <link>https://example.com/items/1</link>
      <guid>item-1</guid>
      <description>LLM systems reached a new milestone.</description>
      <pubDate>Fri, 20 Mar 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

/**
 * Feed fetcher whose responses are scripted from the test body.
 *
 * Queued failures are consumed before queued bodies, so a suite can interleave
 * `queueFailure()` and `queueBody()` to drive the retry/auto-pause path.
 */
export class FakeFeedFetcher {
  private readonly queuedFailures: string[] = [];
  private readonly queuedBodies: string[] = [];

  queueFailure(message: string): void {
    this.queuedFailures.push(message);
  }

  queueBody(body: string): void {
    this.queuedBodies.push(body);
  }

  async fetch(): Promise<FeedFetchResult> {
    const nextFailure = this.queuedFailures.shift();

    if (nextFailure) {
      throw new Error(nextFailure);
    }

    return {
      statusCode: 200,
      durationMs: 12,
      etag: 'etag-1',
      lastModified: 'Fri, 20 Mar 2026 10:00:00 GMT',
      body: this.queuedBodies.shift() ?? DEFAULT_FEED_BODY,
    };
  }
}

export interface RecordedWebhookDelivery {
  readonly alert: AlertNotificationPayload;
  readonly destinationUrl: string;
}

export interface RecordedEmailDelivery {
  readonly alert: AlertNotificationPayload;
  readonly recipients: string[];
}

export interface RecordedTelegramDelivery {
  readonly alert: AlertNotificationPayload;
  readonly chatId: string;
  readonly telegramBotToken?: string;
}

export interface RecordingAlertNotifierOptions {
  readonly enabled?: boolean;
  readonly emailEnabled?: boolean;
  /** `true`/`false` to pin the answer, or a predicate over the resolved token. */
  readonly telegramEnabled?: boolean | ((telegramBotToken?: string) => boolean);
}

/**
 * Full `AlertNotifierPort` implementation that records every delivery.
 *
 * Implementing the interface (rather than duck-typing it) is deliberate: a new
 * channel added to the port breaks compilation here instead of silently
 * no-opping in every integration suite.
 */
export class RecordingAlertNotifier implements AlertNotifierPort {
  readonly webhookDeliveries: RecordedWebhookDelivery[] = [];
  readonly emailDeliveries: RecordedEmailDelivery[] = [];
  readonly telegramDeliveries: RecordedTelegramDelivery[] = [];
  readonly telegramDigestDeliveries: TelegramDigestPayload[] = [];

  /** Number of upcoming webhook sends that must fail before deliveries resume. */
  failuresRemaining = 0;

  constructor(private readonly options: RecordingAlertNotifierOptions = {}) {}

  isEnabled(): boolean {
    return this.options.enabled ?? true;
  }

  isEmailEnabled(): boolean {
    return this.options.emailEnabled ?? true;
  }

  isTelegramEnabled(telegramBotToken?: string): boolean {
    const configured = this.options.telegramEnabled;

    if (typeof configured === 'function') {
      return configured(telegramBotToken);
    }

    return configured ?? Boolean(telegramBotToken);
  }

  async sendWebhook(alert: AlertNotificationPayload, destinationUrl: string): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('webhook_delivery_failed_500');
    }

    this.webhookDeliveries.push({ alert, destinationUrl });
  }

  async sendEmail(alert: AlertNotificationPayload, recipientEmails: string[]): Promise<void> {
    this.emailDeliveries.push({ alert, recipients: recipientEmails });
  }

  async sendTelegram(alert: AlertNotificationPayload, chatId: string, telegramBotToken?: string): Promise<void> {
    this.telegramDeliveries.push({ alert, chatId, telegramBotToken });
  }

  async sendTelegramDigest(payload: TelegramDigestPayload): Promise<void> {
    this.telegramDigestDeliveries.push(payload);
  }
}

/** Accepts any bearer token and always resolves to the same Clerk identity. */
export class FakeClerkSessionVerifier {
  constructor(
    private readonly identity: { subject: string; orgId: string | null } = { subject: 'user_test', orgId: 'org_test' },
  ) {}

  async verify(): Promise<{ subject: string; orgId: string | null }> {
    return this.identity;
  }
}
