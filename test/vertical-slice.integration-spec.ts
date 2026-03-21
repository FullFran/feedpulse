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
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  AlertDeliveryJobData,
  FETCH_FEED_QUEUE_TOKEN,
  FetchFeedJobData,
  REDIS_CONNECTION,
} from '../src/infrastructure/queue/queue.constants';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';
import { ProcessFeedJobUseCase } from '../src/modules/ingestion/application/process-feed-job.use-case';
import { ScheduleDueFeedsUseCase } from '../src/modules/ingestion/application/schedule-due-feeds.use-case';
import { FEED_FETCHER, FeedFetchResult } from '../src/modules/ingestion/domain/feed-fetcher.port';
import { ALERT_NOTIFIER, AlertNotificationPayload, AlertNotifierPort } from '../src/modules/notifications/domain/alert-notifier.port';
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

class FakeRedis {
  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<void> {
    return undefined;
  }
}

class FakeFeedFetcher {
  async fetch(): Promise<FeedFetchResult> {
    return {
      statusCode: 200,
      durationMs: 12,
      etag: 'etag-1',
      lastModified: 'Fri, 20 Mar 2026 10:00:00 GMT',
      body: `<?xml version="1.0" encoding="UTF-8"?>
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

  async send(alert: AlertNotificationPayload): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('webhook_delivery_failed_500');
    }

    this.deliveries.push(alert);
  }
}

async function bootstrapTestSchema(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  const schema = [
    `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
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
    `CREATE TABLE entries (
      id BIGSERIAL PRIMARY KEY,
      feed_id INT NOT NULL REFERENCES feeds(id),
      title TEXT,
      link TEXT,
      guid TEXT,
      content TEXT,
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
      status_code INT,
      response_time_ms INT,
      error BOOLEAN NOT NULL DEFAULT FALSE,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE rules (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      include_keywords TEXT[] NOT NULL,
      exclude_keywords TEXT[] NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE alerts (
      id BIGSERIAL PRIMARY KEY,
      entry_id BIGINT NOT NULL REFERENCES entries(id),
      rule_id INT NOT NULL REFERENCES rules(id),
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
  let fakeQueue: FakeQueue;
  let fakeAlertDeliveryQueue: FakeAlertDeliveryQueue;
  let fakeAlertNotifier: FakeAlertNotifier;

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await bootstrapTestSchema(pool);

    fakeQueue = new FakeQueue();
    fakeAlertDeliveryQueue = new FakeAlertDeliveryQueue();
    fakeAlertNotifier = new FakeAlertNotifier();

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
      .overrideProvider(FEED_FETCHER)
      .useValue(new FakeFeedFetcher())
      .overrideProvider(ALERT_NOTIFIER)
      .useValue(fakeAlertNotifier)
      .compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();

    scheduleDueFeedsUseCase = moduleRef.get(ScheduleDueFeedsUseCase);
    processFeedJobUseCase = moduleRef.get(ProcessFeedJobUseCase);
    processAlertDeliveryUseCase = moduleRef.get(ProcessAlertDeliveryUseCase);
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
    ).rejects.toThrow('webhook_delivery_failed_500');

    const failedAlertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts').expect(200);
    const failedAlert = failedAlertsResponse.body.data.find((alert: { rule: { name: string } }) => alert.rule.name === 'Failure watch');
    expect(failedAlert.deliveryStatus).toBe('retrying');
    expect(failedAlert.lastDeliveryError).toBe('webhook_delivery_failed_500');
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
    expect(dashboardIndexResponse.text).toContain('RSS Monitor Dashboard');
    expect(dashboardIndexResponse.text).toContain('Operator Console');
  });
});
