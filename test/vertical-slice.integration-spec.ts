process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.WEBHOOK_NOTIFIER_URL = 'https://example.com/webhook';
process.env.WEBHOOK_NOTIFIER_TIMEOUT_MS = '500';
process.env.SCHEDULER_TICK_MS = '1000';
process.env.SCHEDULER_BATCH_SIZE = '10';
process.env.WORKER_CONCURRENCY = '1';
process.env.FETCH_TIMEOUT_MS = '1000';
process.env.LOG_LEVEL = 'error';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { AlertDeliveryQueue } from '../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../src/infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../src/infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../src/infrastructure/queue/opml-parse-preview.queue';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  AlertDeliveryJobData,
  FETCH_FEED_QUEUE_TOKEN,
  FetchFeedJobData,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  OpmlApplyImportJobData,
  OpmlParsePreviewJobData,
  REDIS_CONNECTION,
} from '../src/infrastructure/queue/queue.constants';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';
import { ProcessFeedJobUseCase } from '../src/modules/ingestion/application/process-feed-job.use-case';
import { ScheduleDueFeedsUseCase } from '../src/modules/ingestion/application/schedule-due-feeds.use-case';
import { ProcessOpmlApplyJobUseCase } from '../src/modules/opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../src/modules/opml-imports/application/process-opml-parse-job.use-case';
import { FEED_FETCHER, FeedFetchResult } from '../src/modules/ingestion/domain/feed-fetcher.port';
import { ALERT_NOTIFIER, AlertNotificationPayload, AlertNotifierPort, TelegramDigestPayload } from '../src/modules/notifications/domain/alert-notifier.port';
import { configureApiApplication } from '../src/main/create-api-app';

class FakeQueue {
  readonly jobs: FetchFeedJobData[] = [];

  async enqueue(job: FetchFeedJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('Not used in integration test');
  }
}

class FakeAlertDeliveryQueue {
  readonly jobs: AlertDeliveryJobData[] = [];

  async enqueue(job: AlertDeliveryJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('Not used in integration test');
  }
}

class FakeOpmlParseQueue {
  readonly jobs: OpmlParsePreviewJobData[] = [];

  async enqueue(job: OpmlParsePreviewJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('Not used in integration test');
  }
}

class FakeOpmlApplyQueue {
  readonly jobs: OpmlApplyImportJobData[] = [];

  async enqueue(job: OpmlApplyImportJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('Not used in integration test');
  }
}

class FakeRedis {
  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<void> {
    return undefined;
  }
}

class FakeFeedFetcher {
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

    const nextBody = this.queuedBodies.shift();

    return {
      statusCode: 200,
      durationMs: 12,
      etag: 'etag-1',
      lastModified: 'Fri, 20 Mar 2026 10:00:00 GMT',
      body:
        nextBody ??
        `<?xml version="1.0" encoding="UTF-8"?>
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
        </rss>`,
    };
  }
}

class FakeAlertNotifier implements AlertNotifierPort {
  readonly deliveries: AlertNotificationPayload[] = [];
  failuresRemaining = 0;

  isEnabled(): boolean {
    return true;
  }

  isEmailEnabled(): boolean {
    return false;
  }

  isTelegramEnabled(_telegramBotToken?: string): boolean {
    return false;
  }

  async sendWebhook(alert: AlertNotificationPayload, _destinationUrl: string): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('webhook_delivery_failed_500');
    }

    this.deliveries.push(alert);
  }

  async sendEmail(_alert: AlertNotificationPayload, _recipientEmails: string[]): Promise<void> {
    return undefined;
  }

  async sendTelegram(_alert: AlertNotificationPayload, _chatId: string, _telegramBotToken?: string): Promise<void> {
    return undefined;
  }

  async sendTelegramDigest(_payload: TelegramDigestPayload): Promise<void> {
    return undefined;
  }
}

async function bootstrapTestSchema(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  const schema = [
    `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      webhook_notifier_url TEXT,
      recipient_emails TEXT[] NOT NULL DEFAULT '{}',
      telegram_chat_ids TEXT[] NOT NULL DEFAULT '{}',
      telegram_delivery_mode TEXT NOT NULL DEFAULT 'instant',
      telegram_bot_token_ciphertext TEXT,
      telegram_bot_token_iv TEXT,
      telegram_bot_token_tag TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      normalized_url_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      etag TEXT,
      last_modified TEXT,
      last_checked_at TIMESTAMPTZ,
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      poll_interval_seconds INT NOT NULL DEFAULT 1800,
      error_count INT NOT NULL DEFAULT 0,
      last_error TEXT,
      avg_response_ms INT,
      avg_items_per_day DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX idx_feeds_tenant_url_unique ON feeds (tenant_id, url)`,
    `CREATE UNIQUE INDEX idx_feeds_tenant_hash_unique ON feeds (tenant_id, normalized_url_hash) WHERE normalized_url_hash IS NOT NULL`,
    `CREATE TABLE entries (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      feed_id INT NOT NULL REFERENCES feeds(id),
      title TEXT,
      link TEXT,
      guid TEXT,
      content TEXT,
      normalized_search_document TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (feed_id, guid),
      UNIQUE (feed_id, content_hash)
    )`,
    `CREATE TABLE fetch_logs (
      id BIGSERIAL PRIMARY KEY,
      feed_id INT NOT NULL REFERENCES feeds(id),
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      status_code INT,
      response_time_ms INT,
      error BOOLEAN NOT NULL DEFAULT FALSE,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE rules (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      name TEXT NOT NULL,
      include_keywords TEXT[] NOT NULL,
      exclude_keywords TEXT[] NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE alerts (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      entry_id BIGINT NOT NULL REFERENCES entries(id),
      rule_id INT NOT NULL REFERENCES rules(id),
      canonical_link TEXT,
      matched_rules INTEGER[] NOT NULL DEFAULT '{}',
      webhook_delivery_status TEXT NOT NULL DEFAULT 'pending',
      telegram_delivery_status TEXT NOT NULL DEFAULT 'pending',
      email_delivery_status TEXT NOT NULL DEFAULT 'pending',
      sent BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at TIMESTAMPTZ,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      delivery_attempts INT NOT NULL DEFAULT 0,
      last_delivery_attempt_at TIMESTAMPTZ,
      last_delivery_error TEXT,
      last_delivery_queued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, rule_id)
    )`,
    `CREATE UNIQUE INDEX idx_alerts_tenant_rule_canonical_link_unique
      ON alerts (tenant_id, rule_id, canonical_link)
      WHERE canonical_link IS NOT NULL`,
    `CREATE TABLE telegram_digest_items (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (alert_id, chat_id)
    )`,
    `CREATE TABLE opml_imports (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsing', 'preview_ready', 'importing', 'completed', 'failed_validation', 'failed')),
      file_name TEXT NOT NULL,
      file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
      source_checksum TEXT,
      error_message TEXT,
      total_items INT NOT NULL DEFAULT 0 CHECK (total_items >= 0),
      valid_items INT NOT NULL DEFAULT 0 CHECK (valid_items >= 0),
      duplicate_items INT NOT NULL DEFAULT 0 CHECK (duplicate_items >= 0),
      existing_items INT NOT NULL DEFAULT 0 CHECK (existing_items >= 0),
      invalid_items INT NOT NULL DEFAULT 0 CHECK (invalid_items >= 0),
      imported_items INT NOT NULL DEFAULT 0 CHECK (imported_items >= 0),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE opml_import_items (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      import_id BIGINT NOT NULL REFERENCES opml_imports(id) ON DELETE CASCADE,
      title TEXT,
      outline_path TEXT,
      source_xml_url TEXT,
      normalized_url TEXT,
      normalized_url_hash TEXT,
      feed_id INT REFERENCES feeds(id) ON DELETE SET NULL,
      item_status TEXT NOT NULL CHECK (item_status IN ('new', 'existing', 'duplicate', 'invalid', 'imported', 'failed')),
      validation_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT opml_import_items_normalized_url_required
        CHECK (item_status = 'invalid' OR (normalized_url IS NOT NULL AND normalized_url_hash IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX idx_opml_import_items_dedupe_per_import
      ON opml_import_items (import_id, normalized_url_hash)
      WHERE normalized_url_hash IS NOT NULL AND item_status <> 'duplicate'`,
  ];

  for (const statement of schema) {
    await pool.query(statement);
  }
}

describe('vertical slice integration', () => {
  let app: INestApplication;
  let scheduleDueFeedsUseCase: ScheduleDueFeedsUseCase;
  let processFeedJobUseCase: ProcessFeedJobUseCase;
  let processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase;
  let processOpmlParseJobUseCase: ProcessOpmlParseJobUseCase;
  let processOpmlApplyJobUseCase: ProcessOpmlApplyJobUseCase;
  let fakeQueue: FakeQueue;
  let fakeAlertDeliveryQueue: FakeAlertDeliveryQueue;
  let fakeOpmlParseQueue: FakeOpmlParseQueue;
  let fakeOpmlApplyQueue: FakeOpmlApplyQueue;
  let fakeAlertNotifier: FakeAlertNotifier;
  let fakeFeedFetcher: FakeFeedFetcher;
  let pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await bootstrapTestSchema(pool);

    fakeQueue = new FakeQueue();
    fakeAlertDeliveryQueue = new FakeAlertDeliveryQueue();
    fakeOpmlParseQueue = new FakeOpmlParseQueue();
    fakeOpmlApplyQueue = new FakeOpmlApplyQueue();
    fakeAlertNotifier = new FakeAlertNotifier();
    fakeFeedFetcher = new FakeFeedFetcher();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CONNECTION)
      .useValue(new FakeRedis())
      .overrideProvider(FETCH_FEED_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(FetchFeedQueue)
      .useValue(fakeQueue)
      .overrideProvider(ALERT_DELIVERY_QUEUE_TOKEN)
      .useValue(fakeAlertDeliveryQueue)
      .overrideProvider(AlertDeliveryQueue)
      .useValue(fakeAlertDeliveryQueue)
      .overrideProvider(OPML_PARSE_PREVIEW_QUEUE_TOKEN)
      .useValue(fakeOpmlParseQueue)
      .overrideProvider(OpmlParsePreviewQueue)
      .useValue(fakeOpmlParseQueue)
      .overrideProvider(OPML_APPLY_IMPORT_QUEUE_TOKEN)
      .useValue(fakeOpmlApplyQueue)
      .overrideProvider(OpmlApplyImportQueue)
      .useValue(fakeOpmlApplyQueue)
      .overrideProvider(FEED_FETCHER)
      .useValue(fakeFeedFetcher)
      .overrideProvider(ALERT_NOTIFIER)
      .useValue(fakeAlertNotifier)
      .compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();

    scheduleDueFeedsUseCase = moduleRef.get(ScheduleDueFeedsUseCase);
    processFeedJobUseCase = moduleRef.get(ProcessFeedJobUseCase);
    processAlertDeliveryUseCase = moduleRef.get(ProcessAlertDeliveryUseCase);
    processOpmlParseJobUseCase = moduleRef.get(ProcessOpmlParseJobUseCase);
    processOpmlApplyJobUseCase = moduleRef.get(ProcessOpmlApplyJobUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('creates feeds and rules, schedules work, processes entries, delivers alerts, and exposes readiness', async () => {
    const ruleResponse = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'AI updates',
        include_keywords: ['AI'],
        exclude_keywords: ['crypto'],
      })
      .expect(201);

    expect(ruleResponse.body.data.name).toBe('AI updates');

    const feedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/rss.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    expect(feedResponse.body.data.url).toBe('https://example.com/rss.xml');

    const scheduled = await scheduleDueFeedsUseCase.execute();
    expect(scheduled.scheduled).toBe(1);
    expect(fakeQueue.jobs).toHaveLength(1);

    const processed = await processFeedJobUseCase.execute({ feedId: fakeQueue.jobs[0].feedId });
    expect(processed.insertedEntries).toBe(1);
    expect(processed.createdAlerts).toBe(1);
    expect(fakeAlertDeliveryQueue.jobs).toHaveLength(1);

    await processAlertDeliveryUseCase.execute({ alertId: fakeAlertDeliveryQueue.jobs[0].alertId, attemptNumber: 1, willRetry: false });

    expect(fakeAlertNotifier.deliveries).toHaveLength(1);
    expect(fakeAlertNotifier.deliveries[0].rule.name).toBe('AI updates');

    const entriesResponse = await request(app.getHttpServer()).get('/api/v1/entries').expect(200);
    expect(entriesResponse.body.data).toHaveLength(1);
    expect(entriesResponse.body.data[0].title).toBe('AI launch update');

    const alertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts').expect(200);
    expect(alertsResponse.body.data).toHaveLength(1);
    expect(alertsResponse.body.data[0].rule.name).toBe('AI updates');
    expect(alertsResponse.body.data[0].sent).toBe(true);
    expect(alertsResponse.body.data[0].deliveryStatus).toBe('sent');

    const alertId = Number(alertsResponse.body.data[0].id);
    const resendResponse = await request(app.getHttpServer()).post(`/api/v1/alerts/${alertId}/send`).expect(202);
    expect(resendResponse.body.data.status).toBe('already_sent');
    expect(fakeAlertNotifier.deliveries).toHaveLength(1);

    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/ready').expect(200);

    const metricsResponse = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(metricsResponse.text).toContain('rss_entries_ingested_total');
    expect(metricsResponse.text).toContain('rss_alerts_sent_total');
  });

  it('supports feed and rule detail, update, safe delete, and idempotent alert creation', async () => {
    const ruleResponse = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'Platform updates',
        include_keywords: ['milestone'],
      })
      .expect(201);

    const ruleId = ruleResponse.body.data.id;

    await request(app.getHttpServer())
      .get(`/api/v1/rules/${ruleId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.name).toBe('Platform updates');
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/rules/${ruleId}`)
      .send({
        name: 'Platform milestones',
        exclude_keywords: ['ignore'],
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.data.name).toBe('Platform milestones');
        expect(response.body.data.excludeKeywords).toEqual(['ignore']);
      });

    const feedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/updates.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    const feedId = feedResponse.body.data.id;

    await request(app.getHttpServer())
      .get(`/api/v1/feeds/${feedId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.url).toBe('https://example.com/updates.xml');
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/feeds/${feedId}`)
      .send({
        status: 'paused',
        poll_interval_seconds: 600,
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.data.status).toBe('paused');
        expect(response.body.data.pollIntervalSeconds).toBe(600);
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/feeds/${feedId}`)
      .send({
        status: 'active',
      })
      .expect(200);

    const scheduled = await scheduleDueFeedsUseCase.execute();
    expect(scheduled.scheduled).toBeGreaterThanOrEqual(1);

    const firstProcessed = await processFeedJobUseCase.execute({ feedId });
    const secondProcessed = await processFeedJobUseCase.execute({ feedId });
    expect(firstProcessed.createdAlerts).toBeGreaterThanOrEqual(1);
    expect(secondProcessed.createdAlerts).toBe(0);

    for (const job of fakeAlertDeliveryQueue.jobs.splice(0)) {
      await processAlertDeliveryUseCase.execute({ alertId: job.alertId, attemptNumber: 1, willRetry: false });
    }

    await request(app.getHttpServer())
      .post(`/api/v1/feeds/${feedId}/check-now`)
      .expect(202)
      .expect((response) => {
        expect(response.body.data.status).toBe('queued');
      });

    expect(fakeQueue.jobs.some((job) => job.feedId === feedId)).toBe(true);

    const alertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts?sent=true').expect(200);
    const matchingAlerts = alertsResponse.body.data.filter((alert: { rule: { name: string } }) => alert.rule.name === 'Platform milestones');
    expect(matchingAlerts).toHaveLength(1);

    await request(app.getHttpServer()).delete(`/api/v1/rules/${ruleId}`).expect(204);
    await request(app.getHttpServer())
      .get(`/api/v1/rules/${ruleId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.isActive).toBe(false);
      });

    await request(app.getHttpServer()).delete(`/api/v1/feeds/${feedId}`).expect(204);
    await request(app.getHttpServer())
      .get(`/api/v1/feeds/${feedId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.data.status).toBe('paused');
      });
  });

  it('matches include/exclude as normalized full phrases (not disjoint words)', async () => {
    const fullPhraseRule = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'Phrase full match',
        include_keywords: ['ocupacion de una vivienda'],
      })
      .expect(201);

    const accentRule = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'Phrase accent match',
        include_keywords: ['ocupación de una vivienda'],
      })
      .expect(201);

    const excludeRule = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'Phrase exclude block',
        include_keywords: ['sareb'],
        exclude_keywords: ['ocupacion de una promocion'],
      })
      .expect(201);

    const feedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/phrase-matching.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    fakeFeedFetcher.queueBody(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Phrase Feed</title>
          <item>
            <title>Caso confirmado de ocupacion de una vivienda</title>
            <link>https://example.com/phrase/1</link>
            <guid>phrase-1</guid>
            <description>Coincidencia exacta esperada.</description>
            <pubDate>Fri, 20 Mar 2026 09:01:00 GMT</pubDate>
          </item>
          <item>
            <title>Resumen sobre ocupacion irregular de una vivienda</title>
            <link>https://example.com/phrase/2</link>
            <guid>phrase-2</guid>
            <description>No debe coincidir por frase discontinua.</description>
            <pubDate>Fri, 20 Mar 2026 09:02:00 GMT</pubDate>
          </item>
          <item>
            <title>Sareb revisa ocupación de una promoción en curso</title>
            <link>https://example.com/phrase/3</link>
            <guid>phrase-3</guid>
            <description>Debe bloquearse por exclude phrase.</description>
            <pubDate>Fri, 20 Mar 2026 09:03:00 GMT</pubDate>
          </item>
          <item>
            <title>Sareb anuncia nueva operación inmobiliaria</title>
            <link>https://example.com/phrase/4</link>
            <guid>phrase-4</guid>
            <description>Debe coincidir para regla de sareb sin exclude.</description>
            <pubDate>Fri, 20 Mar 2026 09:04:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`);

    const processed = await processFeedJobUseCase.execute({ feedId: Number(feedResponse.body.data.id) });
    expect(processed.insertedEntries).toBe(4);

    const alertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts').expect(200);
    const phraseAlerts = alertsResponse.body.data.filter((alert: { rule: { name: string }; entry: { title: string | null } }) =>
      ['Phrase full match', 'Phrase accent match', 'Phrase exclude block'].includes(alert.rule.name),
    );

    const fullPhraseTitles = phraseAlerts
      .filter((alert: { rule: { name: string }; entry: { title: string | null } }) => alert.rule.name === 'Phrase full match')
      .map((alert: { entry: { title: string | null } }) => alert.entry.title);
    expect(fullPhraseTitles).toContain('Caso confirmado de ocupacion de una vivienda');
    expect(fullPhraseTitles).not.toContain('Resumen sobre ocupacion irregular de una vivienda');

    const accentTitles = phraseAlerts
      .filter((alert: { rule: { name: string }; entry: { title: string | null } }) => alert.rule.name === 'Phrase accent match')
      .map((alert: { entry: { title: string | null } }) => alert.entry.title);
    expect(accentTitles).toContain('Caso confirmado de ocupacion de una vivienda');

    const excludeTitles = phraseAlerts
      .filter((alert: { rule: { name: string }; entry: { title: string | null } }) => alert.rule.name === 'Phrase exclude block')
      .map((alert: { entry: { title: string | null } }) => alert.entry.title);
    expect(excludeTitles).toContain('Sareb anuncia nueva operación inmobiliaria');
    expect(excludeTitles).not.toContain('Sareb revisa ocupación de una promoción en curso');

    expect(fullPhraseRule.body.data.id).toBeDefined();
    expect(accentRule.body.data.id).toBeDefined();
    expect(excludeRule.body.data.id).toBeDefined();
  });

  it('claims due auto-paused feeds but keeps manual paused feeds excluded', async () => {
    const autoPausedFeedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/auto-paused-due.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    const manualPausedFeedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/manual-paused-due.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    const autoPausedFeedId = Number(autoPausedFeedResponse.body.data.id);
    const manualPausedFeedId = Number(manualPausedFeedResponse.body.data.id);

    await pool.query(
      `
        UPDATE feeds
        SET status = 'paused',
            last_error = 'auto-paused: dns resolution temporarily failed',
            next_check_at = NOW() - INTERVAL '5 minutes'
        WHERE id = $1
      `,
      [autoPausedFeedId],
    );

    await pool.query(
      `
        UPDATE feeds
        SET status = 'paused',
            last_error = 'paused manually by operator',
            next_check_at = NOW() - INTERVAL '5 minutes'
        WHERE id = $1
      `,
      [manualPausedFeedId],
    );

    const jobsBefore = fakeQueue.jobs.length;
    await scheduleDueFeedsUseCase.execute();
    const newJobs = fakeQueue.jobs.slice(jobsBefore);

    expect(newJobs.some((job) => job.feedId === autoPausedFeedId)).toBe(true);
    expect(newJobs.some((job) => job.feedId === manualPausedFeedId)).toBe(false);
  });

  it('marks repeated DNS failures as auto-paused with delayed retry', async () => {
    const feedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/dns-flaky.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    const feedId = Number(feedResponse.body.data.id);

    await pool.query(
      `
        UPDATE feeds
        SET error_count = 2,
            status = 'error'
        WHERE id = $1
      `,
      [feedId],
    );

    fakeFeedFetcher.queueFailure('getaddrinfo ENOTFOUND rss.example.invalid');

    await expect(processFeedJobUseCase.execute({ feedId })).resolves.toMatchObject({
      insertedEntries: 0,
      createdAlerts: 0,
      statusCode: 0,
    });

    const feedRowResult = await pool.query(
      'SELECT status, error_count, last_error, next_check_at FROM feeds WHERE id = $1',
      [feedId],
    );
    const row = feedRowResult.rows[0] as {
      status: string;
      error_count: number;
      last_error: string | null;
      next_check_at: Date;
    };

    expect(row.status).toBe('paused');
    expect(row.error_count).toBe(3);
    expect(row.last_error).toContain('auto-paused:');
    expect(row.last_error).toContain('ENOTFOUND');
    expect(new Date(row.next_check_at).getTime()).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000);
  });

  it('runs OPML happy path upload -> preview -> confirm -> status', async () => {
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0">
        <body>
          <outline text="Tech">
            <outline text="AI Feed" xmlUrl="https://example.com/opml-ai.xml" />
            <outline text="AI Feed duplicate" xmlUrl="https://example.com/opml-ai.xml" />
            <outline text="Invalid" xmlUrl="ftp://example.com/nope.xml" />
          </outline>
        </body>
      </opml>`;

    const uploadResponse = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from(opml, 'utf8'), {
        filename: 'feeds.opml',
        contentType: 'text/x-opml',
      })
      .expect(201);

    const importId = Number(uploadResponse.body.data.id);
    expect(importId).toBeGreaterThan(0);
    expect(fakeOpmlParseQueue.jobs).toHaveLength(1);

    await processOpmlParseJobUseCase.execute(fakeOpmlParseQueue.jobs[0]);

    const previewResponse = await request(app.getHttpServer()).get(`/api/v1/opml/imports/${importId}/preview`).expect(200);
    expect(previewResponse.body.summary.status).toBe('preview_ready');
    expect(previewResponse.body.summary.totalItems).toBe(3);
    expect(previewResponse.body.summary.duplicateItems).toBe(1);
    expect(previewResponse.body.summary.invalidItems).toBe(1);

    const confirmResponse = await request(app.getHttpServer()).post(`/api/v1/opml/imports/${importId}/confirm`).expect(202);
    expect(confirmResponse.body.data.status).toBe('queued');
    expect(fakeOpmlApplyQueue.jobs).toHaveLength(1);

    await processOpmlApplyJobUseCase.execute(fakeOpmlApplyQueue.jobs[0]);

    const statusResponse = await request(app.getHttpServer()).get(`/api/v1/opml/imports/${importId}/status`).expect(200);
    expect(statusResponse.body.data.status).toBe('completed');
    expect(statusResponse.body.data.importedItems).toBe(1);
    expect(statusResponse.body.data.progressPercent).toBe(100);

    const secondConfirm = await request(app.getHttpServer()).post(`/api/v1/opml/imports/${importId}/confirm`).expect(202);
    expect(secondConfirm.body.data.status).toBe('already_confirmed');
  });

  it('exposes Swagger UI and OpenAPI JSON for the running API surface', async () => {
    const docsResponse = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(docsResponse.text).toContain('swagger-ui');

    const openApiResponse = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(openApiResponse.body.openapi).toBe('3.0.0');
    expect(openApiResponse.body.info.title).toBe('RSS Monitor API');
    expect(openApiResponse.body.paths['/api/v1/feeds']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/rules']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/entries']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/alerts']).toBeDefined();
    expect(openApiResponse.body.paths['/health']).toBeDefined();
    expect(openApiResponse.body.paths['/ready']).toBeDefined();
    expect(openApiResponse.body.paths['/metrics']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/feeds'].get.responses['200'].content['application/json'].schema.properties.meta.$ref).toContain('PaginatedMetaModel');
    expect(openApiResponse.body.paths['/api/v1/alerts/{id}/send'].post.responses['202']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/feeds/{id}/check-now'].post.responses['202']).toBeDefined();
  });

  it('mounts the dashboard and persists failed alert delivery state for operator retries', async () => {
    const ruleResponse = await request(app.getHttpServer())
      .post('/api/v1/rules')
      .send({
        name: 'Failure watch',
        include_keywords: ['AI'],
      })
      .expect(201);

    const feedResponse = await request(app.getHttpServer())
      .post('/api/v1/feeds')
      .send({
        url: 'https://example.com/failure.xml',
        poll_interval_seconds: 300,
      })
      .expect(201);

    const feedId = feedResponse.body.data.id;

    await processFeedJobUseCase.execute({ feedId });
    const queuedAlert = fakeAlertDeliveryQueue.jobs.pop();
    expect(queuedAlert).toBeDefined();

    fakeAlertNotifier.failuresRemaining = 1;

    await expect(
      processAlertDeliveryUseCase.execute({ alertId: queuedAlert!.alertId, attemptNumber: 1, willRetry: true }),
    ).rejects.toThrow('notification_channels_failed:webhook:webhook_delivery_failed_500');

    const failedAlertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts').expect(200);
    const failedAlert = failedAlertsResponse.body.data.find((alert: { rule: { name: string } }) => alert.rule.name === 'Failure watch');
    expect(failedAlert.deliveryStatus).toBe('retrying');
    expect(failedAlert.lastDeliveryError).toBe('notification_channels_failed:webhook:webhook_delivery_failed_500');
    expect(failedAlert.deliveryAttempts).toBe(1);

    await request(app.getHttpServer())
      .post(`/api/v1/alerts/${failedAlert.id}/send`)
      .expect(202)
      .expect((response) => {
        expect(response.body.data.status).toBe('queued');
      });

    const dashboardResponse = await request(app.getHttpServer()).get('/dashboard').expect(301);
    expect(dashboardResponse.headers.location).toBe('/dashboard/');

    const dashboardIndexResponse = await request(app.getHttpServer()).get('/dashboard/').expect(200);
    expect(dashboardIndexResponse.text).toContain('RSS Operations Dashboard');
    expect(dashboardIndexResponse.text).toContain('Filtrar noticias');
  });
});
