import { NotFoundException } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/infrastructure/persistence/database.service';
import { AlertsRepository } from '../src/modules/alerts/alerts.repository';
import { EntriesRepository } from '../src/modules/entries/entries.repository';
import { FeedsRepository } from '../src/modules/feeds/feeds.repository';
import { OpmlImportsRepository } from '../src/modules/opml-imports/opml-imports.repository';
import { RulesRepository } from '../src/modules/rules/rules.repository';
import { SettingsRepository } from '../src/modules/settings/settings.repository';
import { expectDefined } from './support/expect-defined';

/**
 * OWASP A01 (Broken Access Control) guard for the whole product.
 *
 * FeedPulse has no row-level security and no shared repository base class: multi-tenancy is
 * enforced entirely by `WHERE tenant_id = $N` predicates written by hand in six repositories.
 * That makes it exactly the kind of invariant that holds until someone forgets one predicate,
 * so it is asserted here rather than assumed.
 *
 * Two rules make these cases meaningful:
 *
 *  1. Every assertion runs through the REAL repository classes. Re-implementing the SQL in the
 *     test would only prove the test agrees with itself.
 *  2. It runs against real Postgres with every migration applied. `pg-mem` does not implement
 *     the expression unique index from migration 0018, `xmax`, or the STORED GENERATED
 *     `normalized_search_document` column that the entry search filter reads, so a fake schema
 *     would silently skip the parts most likely to break.
 *
 * Point `TEST_DATABASE_URL` (or `DATABASE_URL`) at a throwaway Postgres 13+ database to run
 * them; the suite skips otherwise. The database is wiped: never aim it at anything you care
 * about.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

const TENANT_A = 'tenant_a';
const TENANT_B = 'tenant_b';

/**
 * Both tenants deliberately use the same feed URL, the same rule name, the same article link
 * and the same search terms. If isolation were keyed on anything other than `tenant_id` these
 * fixtures would collide and the leak would be visible.
 */
const SHARED_FEED_URL = 'https://newswire.example.com/rss';
const SHARED_ARTICLE_LINK = 'https://newswire.example.com/articles/quantum-breakthrough';
const SHARED_RULE_NAME = 'Quantum watch';

interface TenantFixture {
  tenantId: string;
  feedId: number;
  ruleId: number;
  entryId: string;
  alertId: number;
  importId: number;
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    await pool.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

function asDatabaseService(pool: Pool): DatabaseService {
  return {
    query: (text: string, values: unknown[] = []) => pool.query(text, values),
    getPool: () => pool,
  } as unknown as DatabaseService;
}

describeWithDatabase('tenant isolation across every tenant-scoped table', () => {
  let pool: Pool;
  let feedsRepository: FeedsRepository;
  let rulesRepository: RulesRepository;
  let entriesRepository: EntriesRepository;
  let alertsRepository: AlertsRepository;
  let settingsRepository: SettingsRepository;
  let opmlImportsRepository: OpmlImportsRepository;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  /**
   * Seeds one tenant's whole vertical slice through the production repositories, so the fixture
   * itself exercises the write paths that are supposed to stamp `tenant_id`.
   */
  async function seedTenant(tenantId: string, suffix: string): Promise<TenantFixture> {
    const feed = await feedsRepository.create({
      tenantId,
      url: SHARED_FEED_URL,
      pollIntervalSeconds: 1800,
      status: 'active',
    });

    const rule = await rulesRepository.create({
      tenantId,
      name: SHARED_RULE_NAME,
      includeKeywords: ['quantum'],
      excludeKeywords: [],
      isActive: true,
    });

    const [entry] = await entriesRepository.insertMany(tenantId, feed.id, [
      {
        title: 'Quantum breakthrough announced',
        link: SHARED_ARTICLE_LINK,
        guid: `guid-${suffix}`,
        content: 'A quantum computing milestone.',
        contentHash: `hash-${suffix}`,
        publishedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
    ]);

    const outcome = await alertsRepository.createForEntryWithRules(new Map([[expectDefined(entry).id, [rule.id]]]));

    await settingsRepository.upsertNotifierSettings({
      tenantId,
      webhookNotifierUrl: `https://hooks.example.com/${suffix}`,
      recipientEmails: [`ops@${suffix}.example.com`],
      telegramChatIds: [`chat-${suffix}`],
      telegramDeliveryMode: 'instant',
      telegramBotTokenOperation: 'unchanged',
      telegramBotTokenEncrypted: null,
    });

    const opmlImport = await opmlImportsRepository.createImport({
      tenantId,
      fileName: `subscriptions-${suffix}.opml`,
      fileSizeBytes: 1024,
      sourceChecksum: `checksum-${suffix}`,
    });

    return {
      tenantId,
      feedId: feed.id,
      ruleId: rule.id,
      entryId: expectDefined(entry).id,
      alertId: Number(expectDefined(outcome.created[0]).id),
      importId: Number(opmlImport.id),
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await resetSchema(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE opml_import_items, opml_imports, telegram_digest_items, alerts, entries, rules, fetch_logs, feeds, tenant_settings RESTART IDENTITY CASCADE',
    );

    const databaseService = asDatabaseService(pool);
    feedsRepository = new FeedsRepository(databaseService);
    rulesRepository = new RulesRepository(databaseService);
    entriesRepository = new EntriesRepository(databaseService);
    alertsRepository = new AlertsRepository(databaseService);
    settingsRepository = new SettingsRepository(databaseService);
    opmlImportsRepository = new OpmlImportsRepository(databaseService);

    tenantA = await seedTenant(TENANT_A, 'a');
    tenantB = await seedTenant(TENANT_B, 'b');
    // 60s, matching the `beforeAll` budget every other database-gated suite
    // uses — NOT Jest's 5s default, which this hook inherited and which made the
    // whole suite intermittently red.
    //
    // It TRUNCATEs nine tables with RESTART IDENTITY CASCADE and reseeds two
    // tenants before EVERY test. Against a warm PostgreSQL that is sub-second,
    // but on the first run after a container starts — cold shared buffers, the
    // initial checkpoint and autovacuum all landing at once — it comfortably
    // passed 5s and the suite failed with "Exceeded timeout ... for a hook".
    // Because it only reproduced on a clean database it read as flakiness
    // rather than as the fixed startup cost it actually is.
  }, 60_000);

  describe('feeds', () => {
    it('lists only the caller tenant rows, including the total used for pagination', async () => {
      const listed = await feedsRepository.list({ tenantId: TENANT_B, page: 1, pageSize: 50 });

      expect(listed.total).toBe(1);
      expect(listed.items.map((feed) => feed.id)).toEqual([tenantB.feedId]);
      expect(listed.items.map((feed) => feed.tenantId)).toEqual([TENANT_B]);
    });

    it('does not return another tenant feed by id', async () => {
      await expect(feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_B)).resolves.toBeNull();
      await expect(feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_A)).resolves.toMatchObject({
        id: tenantA.feedId,
        tenantId: TENANT_A,
      });
    });

    it('refuses to update another tenant feed and leaves the row untouched', async () => {
      await expect(
        feedsRepository.update({ id: tenantA.feedId, tenantId: TENANT_B, status: 'paused', pollIntervalSeconds: 60 }),
      ).resolves.toBeNull();

      const untouched = await feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_A);
      expect(untouched).toMatchObject({ status: 'active', pollIntervalSeconds: 1800 });
    });

    it('refuses to disable another tenant feed', async () => {
      await expect(feedsRepository.disable(tenantA.feedId, TENANT_B)).resolves.toBe(false);
      await expect(feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_A)).resolves.toMatchObject({
        status: 'active',
      });

      await expect(feedsRepository.disable(tenantA.feedId, TENANT_A)).resolves.toBe(true);
      await expect(feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_A)).resolves.toMatchObject({
        status: 'paused',
      });
    });

    it('keeps the same URL registrable by both tenants', async () => {
      const [rowA, rowB] = await Promise.all([
        feedsRepository.findByIdForTenant(tenantA.feedId, TENANT_A),
        feedsRepository.findByIdForTenant(tenantB.feedId, TENANT_B),
      ]);

      expect(rowA?.url).toBe(SHARED_FEED_URL);
      expect(rowB?.url).toBe(SHARED_FEED_URL);
      expect(rowA?.id).not.toBe(rowB?.id);
    });
  });

  describe('rules', () => {
    it('lists only the caller tenant rules', async () => {
      const listed = await rulesRepository.list({ tenantId: TENANT_B, page: 1, pageSize: 50 });

      expect(listed.total).toBe(1);
      expect(listed.items.map((rule) => rule.id)).toEqual([tenantB.ruleId]);
    });

    it('does not return another tenant rule by id or by name', async () => {
      await expect(rulesRepository.findById(tenantA.ruleId, TENANT_B)).resolves.toBeNull();
      await expect(rulesRepository.findByName(SHARED_RULE_NAME, TENANT_B)).resolves.toMatchObject({
        id: tenantB.ruleId,
      });
    });

    it('never evaluates one tenant articles against another tenant active rules', async () => {
      const activeForB = await rulesRepository.listActive(TENANT_B);

      expect(activeForB.map((rule) => rule.id)).toEqual([tenantB.ruleId]);
    });

    it('refuses to update or disable another tenant rule', async () => {
      await expect(
        rulesRepository.update({ id: tenantA.ruleId, tenantId: TENANT_B, name: 'hijacked' }),
      ).resolves.toBeNull();
      await expect(rulesRepository.disable(tenantA.ruleId, TENANT_B)).resolves.toBe(false);

      const untouched = await rulesRepository.findById(tenantA.ruleId, TENANT_A);
      expect(untouched).toMatchObject({ name: SHARED_RULE_NAME, isActive: true });
    });

    it('upserts by name inside the caller tenant only', async () => {
      await rulesRepository.upsertByName({
        tenantId: TENANT_B,
        name: SHARED_RULE_NAME,
        includeKeywords: ['photonics'],
        excludeKeywords: [],
        isActive: true,
      });

      await expect(rulesRepository.findById(tenantB.ruleId, TENANT_B)).resolves.toMatchObject({
        includeKeywords: ['photonics'],
      });
      await expect(rulesRepository.findById(tenantA.ruleId, TENANT_A)).resolves.toMatchObject({
        includeKeywords: ['quantum'],
      });
    });
  });

  describe('entries', () => {
    it('lists only the caller tenant entries', async () => {
      const listed = await entriesRepository.list({ tenantId: TENANT_B, page: 1, pageSize: 50 });

      expect(listed.total).toBe(1);
      expect(listed.items.map((entry) => entry.id)).toEqual([tenantB.entryId]);
    });

    it('keeps the search filter inside the tenant even when both tenants match the term', async () => {
      const listed = await entriesRepository.list({ tenantId: TENANT_B, page: 1, pageSize: 50, search: 'quantum' });

      expect(listed.total).toBe(1);
      expect(listed.items.map((entry) => entry.id)).toEqual([tenantB.entryId]);
    });

    it('keeps the feed filter inside the tenant, so another tenant feed id yields nothing', async () => {
      const listed = await entriesRepository.list({
        tenantId: TENANT_B,
        page: 1,
        pageSize: 50,
        feedId: tenantA.feedId,
      });

      expect(listed.total).toBe(0);
      expect(listed.items).toEqual([]);
    });

    it('scopes the rule/filter candidate scan to one tenant', async () => {
      const candidates = await entriesRepository.listForFilterSearch(100, TENANT_B);

      expect(candidates.map((candidate) => candidate.id)).toEqual([tenantB.entryId]);
    });
  });

  describe('alerts', () => {
    it('lists only the caller tenant alerts', async () => {
      const listed = await alertsRepository.list({ tenantId: TENANT_B, page: 1, pageSize: 50 });

      expect(listed.total).toBe(1);
      expect(listed.items.map((alert) => alert.id)).toEqual([String(tenantB.alertId)]);
    });

    it('does not return another tenant alert by id', async () => {
      await expect(alertsRepository.findByIdForTenant(tenantA.alertId, TENANT_B)).resolves.toBeNull();
      await expect(alertsRepository.findByIdForTenant(tenantA.alertId, TENANT_A)).resolves.toMatchObject({
        id: String(tenantA.alertId),
        tenantId: TENANT_A,
      });
    });

    it('keeps one alert per tenant even when both tenants publish the same canonical link', async () => {
      const [rowA, rowB] = await Promise.all([
        alertsRepository.findByIdForTenant(tenantA.alertId, TENANT_A),
        alertsRepository.findByIdForTenant(tenantB.alertId, TENANT_B),
      ]);

      expect(rowA?.entry.link).toBe(SHARED_ARTICLE_LINK);
      expect(rowB?.entry.link).toBe(SHARED_ARTICLE_LINK);
      expect(rowA?.id).not.toBe(rowB?.id);
    });

    it('joins the rule from the owning tenant, never a same-named rule of the other tenant', async () => {
      const alert = await alertsRepository.findByIdForTenant(tenantB.alertId, TENANT_B);

      expect(alert?.rule.id).toBe(tenantB.ruleId);
      expect(alert?.rule.id).not.toBe(tenantA.ruleId);
    });
  });

  describe('tenant_settings', () => {
    it('returns only the caller tenant notifier configuration', async () => {
      const settings = await settingsRepository.getByTenantId(TENANT_B);

      expect(settings).toMatchObject({
        tenantId: TENANT_B,
        webhookNotifierUrl: 'https://hooks.example.com/b',
        recipientEmails: ['ops@b.example.com'],
        telegramChatIds: ['chat-b'],
      });
    });

    it('does not let one tenant upsert overwrite another tenant row', async () => {
      await settingsRepository.upsertNotifierSettings({
        tenantId: TENANT_B,
        webhookNotifierUrl: 'https://hooks.example.com/b-updated',
        recipientEmails: [],
        telegramChatIds: [],
        telegramDeliveryMode: 'digest_10m',
        telegramBotTokenOperation: 'clear',
        telegramBotTokenEncrypted: null,
      });

      await expect(settingsRepository.getByTenantId(TENANT_A)).resolves.toMatchObject({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        recipientEmails: ['ops@a.example.com'],
        telegramDeliveryMode: 'instant',
      });
    });

    it('reports no settings for a tenant that has never configured any', async () => {
      await expect(settingsRepository.getByTenantId('tenant_c')).resolves.toBeNull();
    });
  });

  describe('opml_imports', () => {
    it('does not return another tenant import by id', async () => {
      await expect(opmlImportsRepository.findImportByIdForTenant(tenantA.importId, TENANT_B)).resolves.toBeNull();
      await expect(opmlImportsRepository.findImportByIdForTenant(tenantA.importId, TENANT_A)).resolves.toMatchObject({
        id: String(tenantA.importId),
        fileName: 'subscriptions-a.opml',
      });
    });

    it('raises not-found rather than leaking existence when the tenant does not own the import', async () => {
      await expect(opmlImportsRepository.getImportOrThrowForTenant(tenantA.importId, TENANT_B)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(opmlImportsRepository.getImportOrThrowForTenant(tenantA.importId, TENANT_B)).rejects.toThrow(
        'opml_import_not_found',
      );
    });

    it('stamps import items with the parent import tenant', async () => {
      await opmlImportsRepository.replaceImportItems(tenantB.importId, [
        {
          title: 'Newswire',
          outlinePath: 'Root',
          sourceXmlUrl: SHARED_FEED_URL,
          normalizedUrl: SHARED_FEED_URL,
          normalizedUrlHash: 'hash-shared-b',
          itemStatus: 'new',
          validationError: null,
        },
      ]);

      const rows = await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM opml_import_items');
      expect(rows.rows.map((row) => row.tenant_id)).toEqual([TENANT_B]);
    });
  });

  /**
   * The escape hatch is intentional, not an oversight, so it is pinned here rather than left as
   * folklore. Worker and scheduler code holds an id handed over by a queue and has no request
   * context, so it must be able to read across tenants — but every such read now goes through a
   * method whose NAME says so. `rg 'ForWorker'` enumerates the complete cross-tenant surface.
   */
  describe('deliberate cross-tenant escape hatches', () => {
    it('reads a feed across tenants only through findByIdForWorker', async () => {
      await expect(feedsRepository.findByIdForWorker(tenantA.feedId)).resolves.toMatchObject({
        id: tenantA.feedId,
        tenantId: TENANT_A,
      });
    });

    it('routes the transitional optional-tenant feed lookup to the worker read', async () => {
      // `FeedsRepository.findById` keeps an optional tenant id for the ingestion worker.
      // Omitting it must behave exactly like the explicit worker read, and supplying a foreign
      // tenant must still return nothing — no third behaviour hiding in between.
      const viaOptional = await feedsRepository.findById(tenantA.feedId);
      const viaWorker = await feedsRepository.findByIdForWorker(tenantA.feedId);

      expect(viaOptional).toEqual(viaWorker);
      await expect(feedsRepository.findById(tenantA.feedId, TENANT_B)).resolves.toBeNull();
    });

    it('reads an alert across tenants only through findByIdForWorker', async () => {
      await expect(alertsRepository.findByIdForWorker(tenantA.alertId)).resolves.toMatchObject({
        id: String(tenantA.alertId),
        tenantId: TENANT_A,
      });
    });

    it('reads an OPML import across tenants only through findImportByIdForWorker', async () => {
      await expect(opmlImportsRepository.findImportByIdForWorker(tenantA.importId)).resolves.toMatchObject({
        id: String(tenantA.importId),
        fileName: 'subscriptions-a.opml',
      });
    });

    it('disables the tenant predicate when isClaimed is given no tenant, and enforces it otherwise', async () => {
      // `isClaimed` still carries the `($2::text IS NULL OR tenant_id = $2)` form. Binding NULL
      // short-circuits the predicate; binding a tenant id enforces it. Both halves are asserted
      // so the escape hatch cannot be widened or removed by accident.
      const claimed = await feedsRepository.claimDueFeeds(10);
      expect(claimed.map((feed) => feed.id).sort()).toEqual([tenantA.feedId, tenantB.feedId].sort());

      await expect(feedsRepository.isClaimed(tenantA.feedId)).resolves.toBe(true);
      await expect(feedsRepository.isClaimed(tenantA.feedId, TENANT_A)).resolves.toBe(true);
      await expect(feedsRepository.isClaimed(tenantA.feedId, TENANT_B)).resolves.toBe(false);
    });

    it('routes the transitional optional-tenant alert lookup to the worker read', async () => {
      // `AlertsRepository.findById` keeps an optional tenant id for two callers that have not
      // migrated yet. Omitting it must behave exactly like the explicit worker read — no third
      // behaviour hiding in between.
      const viaOptional = await alertsRepository.findById(tenantA.alertId);
      const viaWorker = await alertsRepository.findByIdForWorker(tenantA.alertId);

      expect(viaOptional).toEqual(viaWorker);
      await expect(alertsRepository.findById(tenantA.alertId, TENANT_B)).resolves.toBeNull();
    });

    it('routes the transitional optional-tenant import lookup to the worker read', async () => {
      const viaOptional = await opmlImportsRepository.findImportById(tenantA.importId);
      const viaWorker = await opmlImportsRepository.findImportByIdForWorker(tenantA.importId);

      expect(viaOptional).toEqual(viaWorker);
      await expect(opmlImportsRepository.findImportById(tenantA.importId, TENANT_B)).resolves.toBeNull();
    });
  });
});
