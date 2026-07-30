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

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { configureApiApplication } from '../src/main/create-api-app';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';
import { ProcessFeedJobUseCase } from '../src/modules/ingestion/application/process-feed-job.use-case';
import { ScheduleDueFeedsUseCase } from '../src/modules/ingestion/application/schedule-due-feeds.use-case';
import { FEED_FETCHER } from '../src/modules/ingestion/domain/feed-fetcher.port';
import { ALERT_NOTIFIER } from '../src/modules/notifications/domain/alert-notifier.port';
import { ProcessOpmlApplyJobUseCase } from '../src/modules/opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../src/modules/opml-imports/application/process-opml-parse-job.use-case';
import { expectDefined } from './support/expect-defined';
import type { FakeQueues } from './support/fakes';
import { createFakeQueues, FakeFeedFetcher, overrideQueueProviders, RecordingAlertNotifier } from './support/fakes';
import { resetSchemaWithMigrations } from './support/schema';

/**
 * This slice runs against a REAL PostgreSQL 13+ database rather than `pg-mem`.
 *
 * The ingestion path now depends on SQL that `pg-mem` cannot execute: the alert
 * upsert in `AlertsRepository.createForEntryWithRules` uses `unnest`, the `xmax`
 * system column and an `ON CONFLICT` target inferred from an expression index
 * (migration 0018), and `entries.normalized_search_document` is a STORED
 * GENERATED column (migration 0016). Emulating those would only assert that the
 * emulator matches itself.
 *
 * Point `TEST_DATABASE_URL` (or `DATABASE_URL`) at a throwaway database to run
 * this suite; it skips otherwise. It owns a dedicated `vertical_slice` schema,
 * which it DROPs and recreates on every run, so it can share a database with the
 * other integration suites even under a parallel jest run.
 */
// Only TEST_DATABASE_URL: this file overwrites `DATABASE_URL` above with a
// placeholder the app never connects to, so it cannot be used as a fallback.
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const TEST_SCHEMA = 'vertical_slice';

describeWithDatabase('vertical slice integration', () => {
  let app: INestApplication;
  let scheduleDueFeedsUseCase: ScheduleDueFeedsUseCase;
  let processFeedJobUseCase: ProcessFeedJobUseCase;
  let processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase;
  let processOpmlParseJobUseCase: ProcessOpmlParseJobUseCase;
  let processOpmlApplyJobUseCase: ProcessOpmlApplyJobUseCase;
  let queues: FakeQueues;
  let fakeAlertNotifier: RecordingAlertNotifier;
  let fakeFeedFetcher: FakeFeedFetcher;
  let pool: Pool;

  beforeAll(async () => {
    // `options` scopes every session opened by this pool to the suite's own schema,
    // so the migrations below build an isolated copy of the production schema.
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${TEST_SCHEMA}` });
    await resetSchemaWithMigrations(pool, TEST_SCHEMA);

    queues = createFakeQueues();
    // Email and Telegram stay off: this slice has no tenant settings, so the
    // webhook is the only channel whose behaviour it can assert.
    fakeAlertNotifier = new RecordingAlertNotifier({ emailEnabled: false, telegramEnabled: false });
    fakeFeedFetcher = new FakeFeedFetcher();

    const moduleRef = await overrideQueueProviders(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      queues,
    )
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
  }, 120_000);

  afterAll(async () => {
    if (app) {
      // Closing the Nest context also ends the pool, which is registered as DATABASE_POOL.
      await app.close();
      return;
    }

    await pool?.end();
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
    expect(queues.fetchFeed.jobs).toHaveLength(1);

    const processed = await processFeedJobUseCase.execute({ feedId: expectDefined(queues.fetchFeed.jobs[0]).feedId });
    expect(processed.insertedEntries).toBe(1);
    expect(processed.createdAlerts).toBe(1);
    expect(queues.alertDelivery.jobs).toHaveLength(1);

    await processAlertDeliveryUseCase.execute({
      alertId: expectDefined(queues.alertDelivery.jobs[0]).alertId,
      attemptNumber: 1,
      willRetry: false,
    });

    expect(fakeAlertNotifier.webhookDeliveries).toHaveLength(1);
    expect(expectDefined(fakeAlertNotifier.webhookDeliveries[0]).alert.rule.name).toBe('AI updates');

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
    expect(fakeAlertNotifier.webhookDeliveries).toHaveLength(1);

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

    // Its own article: alerts are deduped per tenant on the canonical link, so reusing
    // the default fixture would only extend the alert the first test already created.
    // Queued twice because the second pass re-fetches the same feed.
    const updatesFeedBody = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Platform Updates</title>
          <item>
            <title>Platform reaches a new milestone</title>
            <link>https://example.com/updates/1</link>
            <guid>updates-1</guid>
            <description>The platform shipped a milestone release.</description>
            <pubDate>Fri, 20 Mar 2026 09:10:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`;
    fakeFeedFetcher.queueBody(updatesFeedBody);
    fakeFeedFetcher.queueBody(updatesFeedBody);

    const firstProcessed = await processFeedJobUseCase.execute({ feedId });
    const secondProcessed = await processFeedJobUseCase.execute({ feedId });
    expect(firstProcessed.createdAlerts).toBeGreaterThanOrEqual(1);
    expect(secondProcessed.createdAlerts).toBe(0);

    for (const job of queues.alertDelivery.jobs.splice(0)) {
      await processAlertDeliveryUseCase.execute({ alertId: job.alertId, attemptNumber: 1, willRetry: false });
    }

    await request(app.getHttpServer())
      .post(`/api/v1/feeds/${feedId}/check-now`)
      .expect(202)
      .expect((response) => {
        expect(response.body.data.status).toBe('queued');
      });

    expect(queues.fetchFeed.jobs.some((job) => job.feedId === feedId)).toBe(true);

    const alertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts?sent=true').expect(200);
    // With "one alert per article" aggregation, the alert should contain the updated rule in matched_rules
    // The alert should have matched rules that include the updated rule ID
    const matchingAlerts = alertsResponse.body.data.filter((alert: { matchedRules: number[] }) =>
      alert.matchedRules.includes(Number(ruleId)),
    );
    expect(matchingAlerts).toHaveLength(1);
    // The alert should also have the original rule (the one created before the update)
    // Since the rule was updated (name changed but ID stays same), matchedRules should contain ruleId
    expect(matchingAlerts[0].matchedRules).toContain(Number(ruleId));

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
    // One alert per article with matched-rules aggregation
    // Filter alerts that have matching rules in matchedRules array
    const phraseAlerts = alertsResponse.body.data.filter((alert: { matchedRules: number[] }) =>
      alert.matchedRules.some((ruleId: number) =>
        [fullPhraseRule.body.data.id, accentRule.body.data.id, excludeRule.body.data.id].includes(ruleId),
      ),
    );

    // With aggregation, the entry "Caso confirmado de ocupacion de una vivienda" should match
    // both "Phrase full match" (id 1) and "Phrase accent match" (id 2) rules
    const consolidatedAlert = phraseAlerts.find(
      (alert: { matchedRules: number[]; entry: { title: string | null } }) =>
        alert.entry.title === 'Caso confirmado de ocupacion de una vivienda',
    );
    expect(consolidatedAlert).toBeDefined();
    // The consolidated alert should contain both rule IDs (full match and accent match)
    expect(consolidatedAlert.matchedRules).toContain(Number(fullPhraseRule.body.data.id));
    expect(consolidatedAlert.matchedRules).toContain(Number(accentRule.body.data.id));

    // The "Phrase full match" entry should NOT contain the discontinuous match
    const fullMatchAlert = phraseAlerts.find(
      (alert: { matchedRules: number[]; entry: { title: string | null } }) =>
        alert.entry.title === 'Resumen sobre ocupacion irregular de una vivienda',
    );
    expect(fullMatchAlert).toBeUndefined(); // Should not generate alert for discontinuous match

    // The exclude rule should work correctly
    const excludeMatchAlert = phraseAlerts.find(
      (alert: { matchedRules: number[]; entry: { title: string | null } }) =>
        alert.entry.title === 'Sareb anuncia nueva operación inmobiliaria',
    );
    expect(excludeMatchAlert).toBeDefined();
    expect(excludeMatchAlert.matchedRules).toContain(Number(excludeRule.body.data.id));

    // The excluded entry should NOT generate an alert
    const excludedAlert = phraseAlerts.find(
      (alert: { entry: { title: string | null } }) =>
        alert.entry.title === 'Sareb revisa ocupación de una promoción en curso',
    );
    expect(excludedAlert).toBeUndefined(); // Excluded by phrase

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

    const jobsBefore = queues.fetchFeed.jobs.length;
    await scheduleDueFeedsUseCase.execute();
    const newJobs = queues.fetchFeed.jobs.slice(jobsBefore);

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
    expect(queues.opmlParse.jobs).toHaveLength(1);

    await processOpmlParseJobUseCase.execute(expectDefined(queues.opmlParse.jobs[0]));

    const previewResponse = await request(app.getHttpServer())
      .get(`/api/v1/opml/imports/${importId}/preview`)
      .expect(200);
    expect(previewResponse.body.summary.status).toBe('preview_ready');
    expect(previewResponse.body.summary.totalItems).toBe(3);
    expect(previewResponse.body.summary.duplicateItems).toBe(1);
    expect(previewResponse.body.summary.invalidItems).toBe(1);

    const confirmResponse = await request(app.getHttpServer())
      .post(`/api/v1/opml/imports/${importId}/confirm`)
      .expect(202);
    expect(confirmResponse.body.data.status).toBe('queued');
    expect(queues.opmlApply.jobs).toHaveLength(1);

    await processOpmlApplyJobUseCase.execute(expectDefined(queues.opmlApply.jobs[0]));

    const statusResponse = await request(app.getHttpServer())
      .get(`/api/v1/opml/imports/${importId}/status`)
      .expect(200);
    expect(statusResponse.body.data.status).toBe('completed');
    expect(statusResponse.body.data.importedItems).toBe(1);
    expect(statusResponse.body.data.progressPercent).toBe(100);

    const secondConfirm = await request(app.getHttpServer())
      .post(`/api/v1/opml/imports/${importId}/confirm`)
      .expect(202);
    expect(secondConfirm.body.data.status).toBe('already_confirmed');
  });

  it('exposes Swagger UI and OpenAPI JSON for the running API surface', async () => {
    const docsResponse = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(docsResponse.text).toContain('swagger-ui');

    const openApiResponse = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(openApiResponse.body.openapi).toBe('3.0.0');
    expect(openApiResponse.body.info.title).toBe('FeedPulse API');
    expect(openApiResponse.body.paths['/api/v1/feeds']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/rules']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/entries']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/alerts']).toBeDefined();
    expect(openApiResponse.body.paths['/health']).toBeDefined();
    expect(openApiResponse.body.paths['/ready']).toBeDefined();
    expect(openApiResponse.body.paths['/metrics']).toBeDefined();
    expect(
      openApiResponse.body.paths['/api/v1/feeds'].get.responses['200'].content['application/json'].schema.properties
        .meta.$ref,
    ).toContain('PaginatedMetaModel');
    expect(openApiResponse.body.paths['/api/v1/alerts/{id}/send'].post.responses['202']).toBeDefined();
    expect(openApiResponse.body.paths['/api/v1/feeds/{id}/check-now'].post.responses['202']).toBeDefined();
  });

  it('mounts the dashboard and persists failed alert delivery state for operator retries', async () => {
    await request(app.getHttpServer())
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

    // Its own article, for the same reason as above: an article already alerted on
    // only extends `matched_rules` and is deliberately never re-delivered.
    fakeFeedFetcher.queueBody(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Failure Feed</title>
          <item>
            <title>AI rollout hits a delivery snag</title>
            <link>https://example.com/failure/1</link>
            <guid>failure-1</guid>
            <description>Delivery of this AI update is expected to fail once.</description>
            <pubDate>Fri, 20 Mar 2026 09:20:00 GMT</pubDate>
          </item>
        </channel>
      </rss>`);

    await processFeedJobUseCase.execute({ feedId });
    const queuedAlert = queues.alertDelivery.jobs.pop();
    expect(queuedAlert).toBeDefined();

    fakeAlertNotifier.failuresRemaining = 1;

    await expect(
      processAlertDeliveryUseCase.execute({ alertId: queuedAlert!.alertId, attemptNumber: 1, willRetry: true }),
    ).rejects.toThrow('notification_channels_failed:webhook:webhook_delivery_failed_500');

    const failedAlertsResponse = await request(app.getHttpServer()).get('/api/v1/alerts').expect(200);
    // Find the alert that is in 'retrying' status (the one that failed delivery)
    // With "one alert per article" aggregation, multiple tests may create alerts for the same article
    // so we filter by delivery status instead of rule name
    const failedAlert = failedAlertsResponse.body.data.find(
      (alert: { deliveryStatus: string }) => alert.deliveryStatus === 'retrying',
    );
    expect(failedAlert).toBeDefined();
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
    expect(dashboardIndexResponse.text).toContain('FeedPulse — Operator Dashboard');
    expect(dashboardIndexResponse.text).toContain('id="entries-heading"');
  });
});
