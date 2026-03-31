process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.WEBHOOK_NOTIFIER_URL = 'https://fallback.example.com/webhook';
process.env.WEBHOOK_NOTIFIER_TIMEOUT_MS = '500';
process.env.SCHEDULER_TICK_MS = '1000';
process.env.SCHEDULER_BATCH_SIZE = '10';
process.env.WORKER_CONCURRENCY = '1';
process.env.FETCH_TIMEOUT_MS = '1000';
process.env.LOG_LEVEL = 'error';
process.env.ENABLE_AUTH = 'true';
process.env.AUTH_PROVIDER = 'clerk_api_key';
process.env.CLERK_SECRET_KEY = 'sk_test_x';

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
  FETCH_FEED_QUEUE_TOKEN,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  REDIS_CONNECTION,
} from '../src/infrastructure/queue/queue.constants';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';
import { ALERT_NOTIFIER, AlertNotificationPayload, AlertNotifierPort } from '../src/modules/notifications/domain/alert-notifier.port';
import { configureApiApplication } from '../src/main/create-api-app';
import { ClerkSessionVerifierService } from '../src/shared/auth/clerk-session-verifier.service';

class FakeQueue {
  async enqueue(): Promise<void> {}
  createWorker() {
    throw new Error('Not used');
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

class CapturingNotifier implements AlertNotifierPort {
  readonly webhookDeliveries: Array<{ alertId: string; destinationUrl: string; tenantId: string }> = [];
  readonly emailDeliveries: Array<{ alertId: string; recipients: string[]; tenantId: string }> = [];

  isEnabled(): boolean {
    return true;
  }

  isEmailEnabled(): boolean {
    return true;
  }

  async sendWebhook(alert: AlertNotificationPayload, destinationUrl: string): Promise<void> {
    this.webhookDeliveries.push({ alertId: alert.id, destinationUrl, tenantId: alert.tenantId });
  }

  async sendEmail(alert: AlertNotificationPayload, recipientEmails: string[]): Promise<void> {
    this.emailDeliveries.push({ alertId: alert.id, recipients: recipientEmails, tenantId: alert.tenantId });
  }
}

class FakeClerkVerifier {
  async verify(): Promise<{ subject: string; orgId: string | null }> {
    return { subject: 'user_test', orgId: 'org_test' };
  }
}

async function bootstrapSchema(pool: { query: (sql: string, values?: unknown[]) => Promise<unknown> }): Promise<void> {
  const statements = [
    `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE tenant_settings (
      tenant_id TEXT PRIMARY KEY,
      webhook_notifier_url TEXT,
      recipient_emails TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      normalized_url_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      poll_interval_seconds INT NOT NULL DEFAULT 1800,
      error_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
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
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
    `CREATE TABLE opml_imports (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      status TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size_bytes BIGINT NOT NULL,
      total_items INT NOT NULL DEFAULT 0,
      valid_items INT NOT NULL DEFAULT 0,
      duplicate_items INT NOT NULL DEFAULT 0,
      existing_items INT NOT NULL DEFAULT 0,
      invalid_items INT NOT NULL DEFAULT 0,
      imported_items INT NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE opml_import_items (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      import_id BIGINT NOT NULL REFERENCES opml_imports(id),
      item_status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}

describe('settings + auth integration', () => {
  let app: INestApplication;
  let pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
  let processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase;
  let capturingNotifier: CapturingNotifier;

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await bootstrapSchema(pool);

    capturingNotifier = new CapturingNotifier();
    const fakeQueue = new FakeQueue();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CONNECTION)
      .useValue(new FakeRedis())
      .overrideProvider(FETCH_FEED_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(FetchFeedQueue)
      .useValue(fakeQueue)
      .overrideProvider(ALERT_DELIVERY_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(AlertDeliveryQueue)
      .useValue(fakeQueue)
      .overrideProvider(OPML_PARSE_PREVIEW_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(OpmlParsePreviewQueue)
      .useValue(fakeQueue)
      .overrideProvider(OPML_APPLY_IMPORT_QUEUE_TOKEN)
      .useValue(fakeQueue)
      .overrideProvider(OpmlApplyImportQueue)
      .useValue(fakeQueue)
      .overrideProvider(ALERT_NOTIFIER)
      .useValue(capturingNotifier)
      .overrideProvider(ClerkSessionVerifierService)
      .useValue(new FakeClerkVerifier())
      .compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();

    processAlertDeliveryUseCase = moduleRef.get(ProcessAlertDeliveryUseCase);
  });

  afterAll(async () => {
    await app.close();
  });

  it('supports settings CRUD with tenant isolation and api-key auth', async () => {
    const tenantA = 'ak_tenant_a';
    const tenantB = 'ak_tenant_b';

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', tenantA)
      .send({ webhook_notifier_url: 'https://hooks.a.example/path', recipient_emails: ['alerts@A.example', 'alerts@a.example'] })
      .expect(200);

    const getA = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(getA.body.data.webhookNotifierUrl).toBe('https://hooks.a.example/path');
    expect(getA.body.data.recipientEmails).toEqual(['alerts@a.example']);

    const getB = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantB).expect(200);
    expect(getB.body.data.webhookNotifierUrl).toBeNull();
    expect(getB.body.data.recipientEmails).toEqual([]);

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', tenantA)
      .send({ webhook_notifier_url: null, recipient_emails: [] })
      .expect(200);

    const cleared = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(cleared.body.data.webhookNotifierUrl).toBeNull();
    expect(cleared.body.data.recipientEmails).toEqual([]);
  });

  it('accepts clerk bearer token path and maps tenant deterministically', async () => {
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyX3Rlc3QiLCJzaWQiOiJzZXNzX3Rlc3QifQ.sig';

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${fakeJwt}`)
      .send({ webhook_notifier_url: 'https://hooks.clerk.example/path', recipient_emails: ['ops@clerk.example'] })
      .expect(200);

    const viaClerk = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${fakeJwt}`)
      .expect(200);

    expect(viaClerk.body.data.webhookNotifierUrl).toBe('https://hooks.clerk.example/path');
    expect(viaClerk.body.data.recipientEmails).toEqual(['ops@clerk.example']);
  });

  it('validates recipient email list format on settings updates', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', 'ak_invalid_emails')
      .send({ recipient_emails: ['valid@example.com', 'not-an-email'] })
      .expect(400);
  });

  it('delivers alert using tenant webhook URL and emails from database', async () => {
    await pool.query(`INSERT INTO feeds (id, tenant_id, url) VALUES (1, 'ak_alert_tenant', 'https://example.com/rss.xml')`);
    await pool.query(
      `INSERT INTO entries (id, tenant_id, feed_id, title, content, content_hash) VALUES (10, 'ak_alert_tenant', 1, 'Title', 'Body', 'hash_1')`,
    );
    await pool.query(
      `INSERT INTO rules (id, tenant_id, name, include_keywords, exclude_keywords, is_active) VALUES (5, 'ak_alert_tenant', 'Rule', ARRAY['ai'], ARRAY[]::text[], true)`,
    );
    await pool.query(`INSERT INTO alerts (id, tenant_id, entry_id, rule_id) VALUES (20, 'ak_alert_tenant', 10, 5)`);
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, webhook_notifier_url, recipient_emails) VALUES ('ak_alert_tenant', 'https://tenant.example/webhook', ARRAY['alerts@example.com'])`,
    );

    await processAlertDeliveryUseCase.execute({ alertId: 20, attemptNumber: 1, willRetry: false });

    expect(capturingNotifier.webhookDeliveries).toHaveLength(1);
    expect(capturingNotifier.webhookDeliveries[0].destinationUrl).toBe('https://tenant.example/webhook');
    expect(capturingNotifier.webhookDeliveries[0].tenantId).toBe('ak_alert_tenant');
    expect(capturingNotifier.emailDeliveries).toHaveLength(1);
    expect(capturingNotifier.emailDeliveries[0].recipients).toEqual(['alerts@example.com']);
  });
});
