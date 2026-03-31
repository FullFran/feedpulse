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
process.env.TENANT_SECRETS_MASTER_KEY = 'tenant-master-key-for-tests';
process.env.TELEGRAM_BOT_TOKEN = 'tg_global_fallback';

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
import { ProcessTelegramDigestsUseCase } from '../src/modules/alerts/application/process-telegram-digests.use-case';
import { ALERT_NOTIFIER, AlertNotificationPayload, AlertNotifierPort, TelegramDigestPayload } from '../src/modules/notifications/domain/alert-notifier.port';
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
  readonly telegramDeliveries: Array<{ alertId: string; chatId: string; tenantId: string; token?: string }> = [];
  readonly telegramDigestDeliveries: TelegramDigestPayload[] = [];

  isEnabled(): boolean {
    return true;
  }

  isEmailEnabled(): boolean {
    return true;
  }

  isTelegramEnabled(telegramBotToken?: string): boolean {
    return Boolean(telegramBotToken);
  }

  async sendWebhook(alert: AlertNotificationPayload, destinationUrl: string): Promise<void> {
    this.webhookDeliveries.push({ alertId: alert.id, destinationUrl, tenantId: alert.tenantId });
  }

  async sendEmail(alert: AlertNotificationPayload, recipientEmails: string[]): Promise<void> {
    this.emailDeliveries.push({ alertId: alert.id, recipients: recipientEmails, tenantId: alert.tenantId });
  }

  async sendTelegram(alert: AlertNotificationPayload, chatId: string, telegramBotToken?: string): Promise<void> {
    this.telegramDeliveries.push({ alertId: alert.id, chatId, tenantId: alert.tenantId, token: telegramBotToken });
  }

  async sendTelegramDigest(payload: TelegramDigestPayload): Promise<void> {
    this.telegramDigestDeliveries.push(payload);
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
  let processTelegramDigestsUseCase: ProcessTelegramDigestsUseCase;
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
    processTelegramDigestsUseCase = moduleRef.get(ProcessTelegramDigestsUseCase);
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
      .send({
        webhook_notifier_url: 'https://hooks.a.example/path',
        recipient_emails: ['alerts@A.example', 'alerts@a.example'],
        telegram_chat_ids: ['-1001', '-1001', '555'],
        telegram_delivery_mode: 'digest_10m',
        telegram_bot_token: 'tenant_token_a',
      })
      .expect(200);

    const getA = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(getA.body.data.webhookNotifierUrl).toBe('https://hooks.a.example/path');
    expect(getA.body.data.recipientEmails).toEqual(['alerts@a.example']);
    expect(getA.body.data.telegramChatIds).toEqual(['-1001', '555']);
    expect(getA.body.data.telegramDeliveryMode).toBe('digest_10m');
    expect(getA.body.data.telegramBotTokenConfigured).toBe(true);
    expect(getA.body.data.telegramBotToken).toBeUndefined();

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', tenantA)
      .send({ webhook_notifier_url: 'https://hooks.a.example/path-2' })
      .expect(200);

    const unchangedWithToken = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(unchangedWithToken.body.data.telegramBotTokenConfigured).toBe(true);

    const getB = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantB).expect(200);
    expect(getB.body.data.webhookNotifierUrl).toBeNull();
    expect(getB.body.data.recipientEmails).toEqual([]);
    expect(getB.body.data.telegramChatIds).toEqual([]);
    expect(getB.body.data.telegramDeliveryMode).toBe('instant');
    expect(getB.body.data.telegramBotTokenConfigured).toBe(false);

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', tenantA)
      .send({
        webhook_notifier_url: null,
        recipient_emails: [],
        telegram_chat_ids: [],
        telegram_delivery_mode: 'instant',
        telegram_bot_token_clear: true,
      })
      .expect(200);

    const cleared = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(cleared.body.data.webhookNotifierUrl).toBeNull();
    expect(cleared.body.data.recipientEmails).toEqual([]);
    expect(cleared.body.data.telegramChatIds).toEqual([]);
    expect(cleared.body.data.telegramDeliveryMode).toBe('instant');
    expect(cleared.body.data.telegramBotTokenConfigured).toBe(false);

    await request(app.getHttpServer()).put('/api/v1/settings').set('x-api-key', tenantA).send({ webhook_notifier_url: 'https://hooks.a.example/updated' }).expect(200);

    const unchanged = await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', tenantA).expect(200);
    expect(unchanged.body.data.telegramBotTokenConfigured).toBe(false);
  });

  it('accepts clerk bearer token path and maps tenant deterministically', async () => {
    const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyX3Rlc3QiLCJzaWQiOiJzZXNzX3Rlc3QifQ.sig';

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('Authorization', `Bearer ${fakeJwt}`)
      .send({
        webhook_notifier_url: 'https://hooks.clerk.example/path',
        recipient_emails: ['ops@clerk.example'],
        telegram_chat_ids: ['99999'],
        telegram_delivery_mode: 'instant',
      })
      .expect(200);

    const viaClerk = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', `Bearer ${fakeJwt}`)
      .expect(200);

    expect(viaClerk.body.data.webhookNotifierUrl).toBe('https://hooks.clerk.example/path');
    expect(viaClerk.body.data.recipientEmails).toEqual(['ops@clerk.example']);
    expect(viaClerk.body.data.telegramChatIds).toEqual(['99999']);
    expect(viaClerk.body.data.telegramDeliveryMode).toBe('instant');
    expect(viaClerk.body.data.telegramBotTokenConfigured).toBe(false);
  });

  it('validates recipient email list format on settings updates', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', 'ak_invalid_emails')
      .send({ recipient_emails: ['valid@example.com', 'not-an-email'] })
      .expect(400);
  });

  it('validates telegram delivery mode and chat ids on settings updates', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', 'ak_invalid_telegram_mode')
      .send({ telegram_chat_ids: ['-1001'], telegram_delivery_mode: 'hourly' })
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

  it('sends telegram immediately when mode is instant', async () => {
    await pool.query(`INSERT INTO feeds (id, tenant_id, url) VALUES (31, 'ak_telegram_instant', 'https://example.com/rss.xml')`);
    await pool.query(
      `INSERT INTO entries (id, tenant_id, feed_id, title, link, content, content_hash) VALUES (310, 'ak_telegram_instant', 31, 'Título TG', 'https://example.com/tg', 'Resumen TG', 'hash_tg_1')`,
    );
    await pool.query(
      `INSERT INTO rules (id, tenant_id, name, include_keywords, exclude_keywords, is_active) VALUES (305, 'ak_telegram_instant', 'Rule TG', ARRAY['ia'], ARRAY[]::text[], true)`,
    );
    await pool.query(`INSERT INTO alerts (id, tenant_id, entry_id, rule_id) VALUES (320, 'ak_telegram_instant', 310, 305)`);
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, webhook_notifier_url, recipient_emails, telegram_chat_ids, telegram_delivery_mode)
       VALUES ('ak_telegram_instant', null, ARRAY[]::text[], ARRAY['-100200'], 'instant')`,
    );

    await processAlertDeliveryUseCase.execute({ alertId: 320, attemptNumber: 1, willRetry: false });

    expect(capturingNotifier.telegramDeliveries.some((d) => String(d.alertId) === '320' && d.chatId === '-100200')).toBe(true);
    expect(capturingNotifier.telegramDeliveries.find((d) => String(d.alertId) === '320')?.token).toBe('tg_global_fallback');
  });

  it('falls back to global token when tenant token decrypt fails', async () => {
    await pool.query(
      `INSERT INTO tenant_settings (
        tenant_id,
        webhook_notifier_url,
        recipient_emails,
        telegram_chat_ids,
        telegram_delivery_mode,
        telegram_bot_token_ciphertext,
        telegram_bot_token_iv,
        telegram_bot_token_tag
      ) VALUES (
        'ak_telegram_broken_cipher',
        null,
        ARRAY[]::text[],
        ARRAY['-100888'],
        'instant',
        'not_base64',
        'also_bad',
        'broken_tag'
      )`,
    );
    await pool.query(`INSERT INTO feeds (id, tenant_id, url) VALUES (61, 'ak_telegram_broken_cipher', 'https://example.com/rss.xml')`);
    await pool.query(
      `INSERT INTO entries (id, tenant_id, feed_id, title, link, content, content_hash) VALUES (610, 'ak_telegram_broken_cipher', 61, 'Título fallback', 'https://example.com/fallback', 'Resumen', 'hash_tenant_token_2')`,
    );
    await pool.query(
      `INSERT INTO rules (id, tenant_id, name, include_keywords, exclude_keywords, is_active) VALUES (605, 'ak_telegram_broken_cipher', 'Rule fallback', ARRAY['ia'], ARRAY[]::text[], true)`,
    );
    await pool.query(`INSERT INTO alerts (id, tenant_id, entry_id, rule_id) VALUES (620, 'ak_telegram_broken_cipher', 610, 605)`);

    await processAlertDeliveryUseCase.execute({ alertId: 620, attemptNumber: 1, willRetry: false });

    expect(capturingNotifier.telegramDeliveries.find((d) => String(d.alertId) === '620')?.token).toBe('tg_global_fallback');
  });

  it('queues and sends grouped telegram digest when mode is digest_10m', async () => {
    await pool.query(`INSERT INTO feeds (id, tenant_id, url) VALUES (41, 'ak_telegram_digest', 'https://example.com/rss.xml')`);
    await pool.query(
      `INSERT INTO entries (id, tenant_id, feed_id, title, link, content, content_hash) VALUES
      (410, 'ak_telegram_digest', 41, 'Título A', 'https://example.com/a', 'Resumen A', 'hash_tg_a'),
      (411, 'ak_telegram_digest', 41, 'Título B', 'https://example.com/b', 'Resumen B', 'hash_tg_b')`,
    );
    await pool.query(
      `INSERT INTO rules (id, tenant_id, name, include_keywords, exclude_keywords, is_active) VALUES (405, 'ak_telegram_digest', 'Rule TG digest', ARRAY['ia'], ARRAY[]::text[], true)`,
    );
    await pool.query(
      `INSERT INTO alerts (id, tenant_id, entry_id, rule_id) VALUES
      (420, 'ak_telegram_digest', 410, 405),
      (421, 'ak_telegram_digest', 411, 405)`,
    );
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, webhook_notifier_url, recipient_emails, telegram_chat_ids, telegram_delivery_mode)
       VALUES ('ak_telegram_digest', null, ARRAY[]::text[], ARRAY['-100300'], 'digest_10m')`,
    );

    await processAlertDeliveryUseCase.execute({ alertId: 420, attemptNumber: 1, willRetry: false });
    await processAlertDeliveryUseCase.execute({ alertId: 421, attemptNumber: 1, willRetry: false });

    const pending = await pool.query(`SELECT COUNT(*)::text AS count FROM telegram_digest_items WHERE tenant_id = 'ak_telegram_digest' AND sent_at IS NULL`);
    expect(Number(pending.rows[0].count)).toBe(2);

    const digestResult = await processTelegramDigestsUseCase.execute({ now: new Date(Date.now() + 15 * 60 * 1000) });
    expect(digestResult.processedGroups).toBe(1);
    expect(digestResult.sentItems).toBe(2);
    expect(capturingNotifier.telegramDigestDeliveries.some((delivery) => delivery.chatId === '-100300' && delivery.items.length === 2)).toBe(true);

    const sent = await pool.query(`SELECT COUNT(*)::text AS count FROM telegram_digest_items WHERE tenant_id = 'ak_telegram_digest' AND sent_at IS NOT NULL`);
    expect(Number(sent.rows[0].count)).toBe(2);
  });
});
