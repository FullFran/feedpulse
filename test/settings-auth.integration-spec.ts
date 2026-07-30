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
process.env.TENANT_SECRETS_MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
process.env.TELEGRAM_BOT_TOKEN = 'tg_global_fallback';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { configureApiApplication } from '../src/main/create-api-app';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';
import { ProcessTelegramDigestsUseCase } from '../src/modules/alerts/application/process-telegram-digests.use-case';
import { ALERT_NOTIFIER } from '../src/modules/notifications/domain/alert-notifier.port';
import { ClerkSessionVerifierService } from '../src/shared/auth/clerk-session-verifier.service';
import {
  insertAlert,
  insertEntry,
  insertFeed,
  insertRule,
  insertTenantSettings,
  issueApiKey,
} from './support/builders';
import { expectDefined } from './support/expect-defined';
import {
  createFakeQueues,
  FakeClerkSessionVerifier,
  overrideQueueProviders,
  RecordingAlertNotifier,
} from './support/fakes';
import type { PgMemPool } from './support/pg-mem';
import { createPgMemPoolWithSchema } from './support/schema';

/**
 * API keys are now real credentials looked up in the `api_keys` table: sending an arbitrary string
 * no longer conjures a tenant. Each tenant used by this suite gets a key issued up front, and the
 * tests send the plaintext while asserting against the stored tenant id.
 */
const ISSUED_API_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['ak_tenant_a', 'fp_tenanta1_integration-secret-a'],
  ['ak_tenant_b', 'fp_tenantb1_integration-secret-b'],
  ['ak_invalid_emails', 'fp_invemail_integration-secret-c'],
  ['ak_invalid_telegram_mode', 'fp_invtgmd_integration-secret-d'],
];

function keyFor(tenantId: string): string {
  const issued = ISSUED_API_KEYS.find(([tenant]) => tenant === tenantId);
  if (!issued) {
    throw new Error(`No API key issued for tenant ${tenantId}`);
  }

  return issued[1];
}

describe('settings + auth integration', () => {
  let app: INestApplication;
  let pool: PgMemPool;
  let processAlertDeliveryUseCase: ProcessAlertDeliveryUseCase;
  let processTelegramDigestsUseCase: ProcessTelegramDigestsUseCase;
  let capturingNotifier: RecordingAlertNotifier;

  beforeAll(async () => {
    ({ pool } = await createPgMemPoolWithSchema());

    for (const [tenantId, plaintextKey] of ISSUED_API_KEYS) {
      await issueApiKey(pool, { tenantId, plaintextKey });
    }

    capturingNotifier = new RecordingAlertNotifier();

    const moduleRef = await overrideQueueProviders(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      createFakeQueues(),
    )
      .overrideProvider(ALERT_NOTIFIER)
      .useValue(capturingNotifier)
      .overrideProvider(ClerkSessionVerifierService)
      .useValue(new FakeClerkSessionVerifier())
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
      .set('x-api-key', keyFor(tenantA))
      .send({
        webhook_notifier_url: 'https://hooks.a.example/path',
        recipient_emails: ['alerts@A.example', 'alerts@a.example'],
        telegram_chat_ids: ['-1001', '-1001', '555'],
        telegram_delivery_mode: 'digest_10m',
        telegram_bot_token: 'tenant_token_a',
      })
      .expect(200);

    const getA = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .expect(200);
    expect(getA.body.data.webhookNotifierUrl).toBe('https://hooks.a.example/path');
    expect(getA.body.data.recipientEmails).toEqual(['alerts@a.example']);
    expect(getA.body.data.telegramChatIds).toEqual(['-1001', '555']);
    expect(getA.body.data.telegramDeliveryMode).toBe('digest_10m');
    expect(getA.body.data.telegramBotTokenConfigured).toBe(true);
    expect(getA.body.data.telegramBotToken).toBeUndefined();

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .send({ webhook_notifier_url: 'https://hooks.a.example/path-2' })
      .expect(200);

    const unchangedWithToken = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .expect(200);
    expect(unchangedWithToken.body.data.telegramBotTokenConfigured).toBe(true);

    const getB = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('x-api-key', keyFor(tenantB))
      .expect(200);
    expect(getB.body.data.webhookNotifierUrl).toBeNull();
    expect(getB.body.data.recipientEmails).toEqual([]);
    expect(getB.body.data.telegramChatIds).toEqual([]);
    expect(getB.body.data.telegramDeliveryMode).toBe('instant');
    expect(getB.body.data.telegramBotTokenConfigured).toBe(false);

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .send({
        webhook_notifier_url: null,
        recipient_emails: [],
        telegram_chat_ids: [],
        telegram_delivery_mode: 'instant',
        telegram_bot_token_clear: true,
      })
      .expect(200);

    const cleared = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .expect(200);
    expect(cleared.body.data.webhookNotifierUrl).toBeNull();
    expect(cleared.body.data.recipientEmails).toEqual([]);
    expect(cleared.body.data.telegramChatIds).toEqual([]);
    expect(cleared.body.data.telegramDeliveryMode).toBe('instant');
    expect(cleared.body.data.telegramBotTokenConfigured).toBe(false);

    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .send({ webhook_notifier_url: 'https://hooks.a.example/updated' })
      .expect(200);

    const unchanged = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('x-api-key', keyFor(tenantA))
      .expect(200);
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

  it('rejects credentials that are not stored in the api_keys table', async () => {
    await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', 'fp_00000000_never-issued').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set('Authorization', 'Bearer fp_00000000_never-issued')
      .expect(401);
    await request(app.getHttpServer()).get('/api/v1/settings').expect(401);
  });

  it('rejects a revoked key while its sibling key for the same tenant keeps working', async () => {
    const plaintextKey = 'fp_revoked1_integration-secret-e';
    await issueApiKey(pool, { plaintextKey, tenantId: 'ak_tenant_a', label: 'to-revoke' });

    await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', plaintextKey).expect(200);

    await pool.query(`UPDATE api_keys SET revoked_at = NOW() WHERE label = 'to-revoke'`);

    await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', plaintextKey).expect(401);
    await request(app.getHttpServer()).get('/api/v1/settings').set('x-api-key', keyFor('ak_tenant_a')).expect(200);
  });

  it('validates recipient email list format on settings updates', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', keyFor('ak_invalid_emails'))
      .send({ recipient_emails: ['valid@example.com', 'not-an-email'] })
      .expect(400);
  });

  it('validates telegram delivery mode and chat ids on settings updates', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings')
      .set('x-api-key', keyFor('ak_invalid_telegram_mode'))
      .send({ telegram_chat_ids: ['-1001'], telegram_delivery_mode: 'hourly' })
      .expect(400);
  });

  it('delivers alert using tenant webhook URL and emails from database', async () => {
    const tenantId = 'ak_alert_tenant';

    await insertFeed(pool, { id: 1, tenantId, url: 'https://example.com/rss.xml' });
    await insertEntry(pool, { id: 10, tenantId, feedId: 1, title: 'Title', content: 'Body', contentHash: 'hash_1' });
    await insertRule(pool, { id: 5, tenantId, name: 'Rule', includeKeywords: ['ai'], isActive: true });
    await insertAlert(pool, { id: 20, tenantId, entryId: 10, ruleId: 5 });
    await insertTenantSettings(pool, {
      tenantId,
      webhookNotifierUrl: 'https://tenant.example/webhook',
      recipientEmails: ['alerts@example.com'],
    });

    await processAlertDeliveryUseCase.execute({ alertId: 20, attemptNumber: 1, willRetry: false });

    expect(capturingNotifier.webhookDeliveries).toHaveLength(1);
    expect(expectDefined(capturingNotifier.webhookDeliveries[0]).destinationUrl).toBe('https://tenant.example/webhook');
    expect(expectDefined(capturingNotifier.webhookDeliveries[0]).alert.tenantId).toBe(tenantId);
    expect(capturingNotifier.emailDeliveries).toHaveLength(1);
    expect(expectDefined(capturingNotifier.emailDeliveries[0]).recipients).toEqual(['alerts@example.com']);
  });

  it('sends telegram immediately when mode is instant', async () => {
    const tenantId = 'ak_telegram_instant';

    await insertFeed(pool, { id: 31, tenantId, url: 'https://example.com/rss.xml' });
    await insertEntry(pool, {
      id: 310,
      tenantId,
      feedId: 31,
      title: 'Título TG',
      link: 'https://example.com/tg',
      content: 'Resumen TG',
      contentHash: 'hash_tg_1',
    });
    await insertRule(pool, { id: 305, tenantId, name: 'Rule TG', includeKeywords: ['ia'], isActive: true });
    await insertAlert(pool, { id: 320, tenantId, entryId: 310, ruleId: 305 });
    await insertTenantSettings(pool, {
      tenantId,
      webhookNotifierUrl: null,
      recipientEmails: [],
      telegramChatIds: ['-100200'],
      telegramDeliveryMode: 'instant',
    });

    await processAlertDeliveryUseCase.execute({ alertId: 320, attemptNumber: 1, willRetry: false });

    // `String(...)`: `AlertNotificationPayload.id` is typed as a string because the
    // `pg` driver returns BIGINT that way, but pg-mem hands back a JavaScript number.
    expect(
      capturingNotifier.telegramDeliveries.some((d) => String(d.alert.id) === '320' && d.chatId === '-100200'),
    ).toBe(true);
    expect(capturingNotifier.telegramDeliveries.find((d) => String(d.alert.id) === '320')?.telegramBotToken).toBe(
      'tg_global_fallback',
    );
  });

  /**
   * BEHAVIOUR CHANGE (migration 0021 / tenant secrets hardening): this test used
   * to assert the opposite - that an unreadable tenant ciphertext silently fell
   * back to the operator's global `TELEGRAM_BOT_TOKEN`. That is the failure mode
   * where one botched `TENANT_SECRETS_MASTER_KEY` rotation reroutes every
   * tenant's alerts through the operator's own bot, with nothing louder than a
   * WARN. A tenant that asked for its own bot must never be answered with
   * someone else's, so Telegram delivery is skipped and the resolver logs an
   * error plus `rss_tenant_secret_decrypt_failures_total`.
   */
  it('does not fall back to the global token when tenant token decrypt fails', async () => {
    const tenantId = 'ak_telegram_broken_cipher';

    await insertTenantSettings(pool, {
      tenantId,
      webhookNotifierUrl: null,
      recipientEmails: [],
      telegramChatIds: ['-100888'],
      telegramDeliveryMode: 'instant',
      telegramBotTokenCiphertext: 'not_base64',
      telegramBotTokenIv: 'also_bad',
      telegramBotTokenTag: 'broken_tag',
    });
    await insertFeed(pool, { id: 61, tenantId, url: 'https://example.com/rss.xml' });
    await insertEntry(pool, {
      id: 610,
      tenantId,
      feedId: 61,
      title: 'Título fallback',
      link: 'https://example.com/fallback',
      content: 'Resumen',
      contentHash: 'hash_tenant_token_2',
    });
    await insertRule(pool, { id: 605, tenantId, name: 'Rule fallback', includeKeywords: ['ia'], isActive: true });
    await insertAlert(pool, { id: 620, tenantId, entryId: 610, ruleId: 605 });

    await processAlertDeliveryUseCase.execute({ alertId: 620, attemptNumber: 1, willRetry: false });

    expect(capturingNotifier.telegramDeliveries.find((d) => String(d.alert.id) === '620')).toBeUndefined();
  });

  it('queues and sends grouped telegram digest when mode is digest_10m', async () => {
    const tenantId = 'ak_telegram_digest';

    await insertFeed(pool, { id: 41, tenantId, url: 'https://example.com/rss.xml' });
    await insertEntry(pool, {
      id: 410,
      tenantId,
      feedId: 41,
      title: 'Título A',
      link: 'https://example.com/a',
      content: 'Resumen A',
      contentHash: 'hash_tg_a',
    });
    await insertEntry(pool, {
      id: 411,
      tenantId,
      feedId: 41,
      title: 'Título B',
      link: 'https://example.com/b',
      content: 'Resumen B',
      contentHash: 'hash_tg_b',
    });
    await insertRule(pool, { id: 405, tenantId, name: 'Rule TG digest', includeKeywords: ['ia'], isActive: true });
    await insertAlert(pool, { id: 420, tenantId, entryId: 410, ruleId: 405 });
    await insertAlert(pool, { id: 421, tenantId, entryId: 411, ruleId: 405 });
    await insertTenantSettings(pool, {
      tenantId,
      webhookNotifierUrl: null,
      recipientEmails: [],
      telegramChatIds: ['-100300'],
      telegramDeliveryMode: 'digest_10m',
    });

    await processAlertDeliveryUseCase.execute({ alertId: 420, attemptNumber: 1, willRetry: false });
    await processAlertDeliveryUseCase.execute({ alertId: 421, attemptNumber: 1, willRetry: false });

    const pending = await pool.query(
      `SELECT COUNT(*)::text AS count FROM telegram_digest_items WHERE tenant_id = 'ak_telegram_digest' AND sent_at IS NULL`,
    );
    expect(Number(expectDefined(pending.rows[0]).count)).toBe(2);

    const digestResult = await processTelegramDigestsUseCase.execute({ now: new Date(Date.now() + 15 * 60 * 1000) });
    expect(digestResult.processedGroups).toBe(1);
    expect(digestResult.sentItems).toBe(2);
    expect(
      capturingNotifier.telegramDigestDeliveries.some(
        (delivery) => delivery.chatId === '-100300' && delivery.items.length === 2,
      ),
    ).toBe(true);

    const sent = await pool.query(
      `SELECT COUNT(*)::text AS count FROM telegram_digest_items WHERE tenant_id = 'ak_telegram_digest' AND sent_at IS NOT NULL`,
    );
    expect(Number(expectDefined(sent.rows[0]).count)).toBe(2);
  });
});
