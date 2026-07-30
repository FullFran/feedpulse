process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3021';
process.env['DATABASE_URL'] = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['WEBHOOK_NOTIFIER_URL'] = 'https://fallback.example.com/webhook';
process.env['LOG_LEVEL'] = 'error';
process.env['ENABLE_AUTH'] = 'true';
process.env['AUTH_PROVIDER'] = 'clerk_api_key';
process.env['CLERK_SECRET_KEY'] = 'sk_test_x';
process.env['TENANT_SECRETS_MASTER_KEY'] = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { DatabaseService } from '../src/infrastructure/persistence/database.service';
import { configureApiApplication } from '../src/main/create-api-app';
import { ENTRY_SEARCH_MAX_LENGTH } from '../src/modules/entries/dto/list-entries.query';
import type { Rule } from '../src/modules/rules/domain/rule.entity';
import { BATCH_CREATE_RULES_MAX_ITEMS } from '../src/modules/rules/dto/batch-create-rules.dto';
import { RULE_KEYWORD_MAX_LENGTH } from '../src/modules/rules/dto/create-rule.dto';
import { RulesRepository } from '../src/modules/rules/rules.repository';
import { ClerkSessionVerifierService } from '../src/shared/auth/clerk-session-verifier.service';
import { issueApiKey } from './support/builders';
import { expectDefined } from './support/expect-defined';
import { createFakeQueues, FakeClerkSessionVerifier, overrideQueueProviders } from './support/fakes';
import type { PgMemPool } from './support/pg-mem';
import { createPgMemPoolWithSchema, readMigrationFiles } from './support/schema';

/**
 * End-to-end half of the batch-rules unit.
 *
 * Two independent halves live here:
 *
 *  1. `POST /api/v1/rules/batch` over a booted Nest app on pg-mem. This is where the real status
 *     codes come from: the global `ValidationPipe` and `AllExceptionsFilter` are the things that
 *     turn "51 items" into a 400 envelope, and neither can be observed from a DTO in isolation.
 *     It runs with or without `TEST_DATABASE_URL`.
 *  2. Migration 0020 against a real PostgreSQL. The dedupe is a PL/pgSQL `DO` block with a
 *     `ROW_NUMBER()` window and a suffix search; pg-mem implements none of it, so this half skips
 *     unless `TEST_DATABASE_URL` points somewhere.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;

const TEST_SCHEMA = 'rules_batch';

const TENANT_A_KEY = 'fp_rulesba_batch-secret-a';
const TENANT_B_KEY = 'fp_rulesbb_batch-secret-b';

/**
 * `test/support/schema.ts` is the single source of truth for the pg-mem schema and it is owned by
 * the integrator. Until `idx_rules_tenant_name_unique` lands there, this suite creates it itself;
 * afterwards the CREATE is a no-op. Either way the app under test sees the index migration 0020
 * ships, which is what `ON CONFLICT (tenant_id, name)` needs to resolve.
 */
async function ensureRulesUniqueIndex(pool: PgMemPool): Promise<void> {
  try {
    await pool.query('CREATE UNIQUE INDEX idx_rules_tenant_name_unique ON rules (tenant_id, name)');
  } catch (error) {
    if (!/already exists/i.test((error as Error).message)) {
      throw error;
    }
  }
}

function ruleItem(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, include_keywords: ['ocupacion'], ...overrides };
}

/** `POST /api/v1/rules/batch` payload shape, as the caller sees it inside the success envelope. */
interface BatchResult {
  created: Rule[];
  skippedNames: string[];
  duplicateNames: string[];
}

interface SuccessEnvelope<T> {
  data: T;
  meta: { total?: number };
}

interface ErrorEnvelope {
  code: string;
  message: string;
}

/** `supertest` types `response.body` as `any`; every read goes through one of these instead. */
function successBody<T>(response: request.Response): SuccessEnvelope<T> {
  return response.body as SuccessEnvelope<T>;
}

function errorBody(response: request.Response): ErrorEnvelope {
  return response.body as ErrorEnvelope;
}

describe('POST /api/v1/rules/batch', () => {
  let app: INestApplication;
  let pool: PgMemPool;

  beforeAll(async () => {
    ({ pool } = await createPgMemPoolWithSchema());
    await ensureRulesUniqueIndex(pool);
    await issueApiKey(pool, { tenantId: 'ak_batch_a', plaintextKey: TENANT_A_KEY });
    await issueApiKey(pool, { tenantId: 'ak_batch_b', plaintextKey: TENANT_B_KEY });

    const moduleRef = await overrideQueueProviders(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      createFakeQueues(),
    )
      .overrideProvider(ClerkSessionVerifierService)
      .useValue(new FakeClerkSessionVerifier())
      .compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  /** `INestApplication.getHttpServer()` is typed `any`; narrowing it once keeps the cases clean. */
  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function postBatch(apiKey: string, body: unknown): request.Test {
    return request(server())
      .post('/api/v1/rules/batch')
      .set('x-api-key', apiKey)
      .send(body as object);
  }

  it('creates a full 50-rule batch in one call', async () => {
    const response = await postBatch(TENANT_A_KEY, {
      rules: Array.from({ length: BATCH_CREATE_RULES_MAX_ITEMS }, (_value, index) => ruleItem(`Bulk rule ${index}`)),
    }).expect(201);

    const result = successBody<BatchResult>(response).data;
    expect(result.created).toHaveLength(BATCH_CREATE_RULES_MAX_ITEMS);
    expect(result.skippedNames).toEqual([]);
    expect(result.duplicateNames).toEqual([]);
    expect(result.created[0]).toMatchObject({ isActive: true, includeKeywords: ['ocupacion'] });

    const listed = await request(server())
      .get('/api/v1/rules?page=1&page_size=200')
      .set('x-api-key', TENANT_A_KEY)
      .expect(200);
    expect(successBody<Rule[]>(listed).meta.total).toBe(BATCH_CREATE_RULES_MAX_ITEMS);
  });

  it('skips a name the tenant already uses instead of overwriting it, and says so', async () => {
    await postBatch(TENANT_B_KEY, { rules: [ruleItem('Existing rule', { include_keywords: ['original'] })] }).expect(
      201,
    );

    const response = await postBatch(TENANT_B_KEY, {
      rules: [ruleItem('Existing rule', { include_keywords: ['hijacked'], is_active: false }), ruleItem('Brand new')],
    }).expect(201);

    const result = successBody<BatchResult>(response).data;
    expect(result.created.map((rule) => rule.name)).toEqual(['Brand new']);
    expect(result.skippedNames).toEqual(['Existing rule']);

    const listed = await request(server())
      .get('/api/v1/rules?page=1&page_size=200&q=Existing')
      .set('x-api-key', TENANT_B_KEY)
      .expect(200);
    const stored = successBody<Rule[]>(listed).data;
    expect(stored).toHaveLength(1);
    // The whole point of create-only: the stored rule is untouched, not merged and not disabled.
    expect(stored[0]).toMatchObject({ includeKeywords: ['original'], isActive: true });
  });

  it('collapses two identical names inside one batch into a single created rule', async () => {
    const response = await postBatch(TENANT_B_KEY, {
      rules: [
        ruleItem('Twice named', { include_keywords: ['first'] }),
        ruleItem('Twice named', { include_keywords: ['second'] }),
      ],
    }).expect(201);

    const result = successBody<BatchResult>(response).data;
    expect(result.created).toHaveLength(1);
    expect(expectDefined(result.created[0]).includeKeywords).toEqual(['first']);
    expect(result.duplicateNames).toEqual(['Twice named']);
    expect(result.skippedNames).toEqual([]);
  });

  it('keeps one tenant batch out of another tenant rule set', async () => {
    const shared = 'Shared across tenants';
    await postBatch(TENANT_A_KEY, { rules: [ruleItem(shared, { include_keywords: ['a-side'] })] }).expect(201);

    const forB = await postBatch(TENANT_B_KEY, {
      rules: [ruleItem(shared, { include_keywords: ['b-side'] })],
    }).expect(201);

    // The same name is free for tenant B: uniqueness is per tenant, not global.
    const result = successBody<BatchResult>(forB).data;
    expect(result.created).toHaveLength(1);
    expect(expectDefined(result.created[0]).includeKeywords).toEqual(['b-side']);
    expect(result.skippedNames).toEqual([]);
  });

  it.each([
    [
      'more than 50 items',
      {
        rules: Array.from({ length: BATCH_CREATE_RULES_MAX_ITEMS + 1 }, (_value, index) =>
          ruleItem(`Overflow ${index}`),
        ),
      },
      'batch_rules_exceeds_max',
    ],
    ['an empty array', { rules: [] }, 'batch_rules_empty'],
    [
      'a keyword over 200 characters',
      { rules: [ruleItem('Oversized', { include_keywords: ['k'.repeat(RULE_KEYWORD_MAX_LENGTH + 1)] })] },
      'rule_keyword_too_long',
    ],
    ['a rule with no include keywords', { rules: [{ name: 'Empty' }] }, 'rule_missing_include_keywords'],
  ])('rejects %s with 400', async (_label, body, expectedMessage) => {
    const response = await postBatch(TENANT_A_KEY, body).expect(400);

    expect(errorBody(response).message).toContain(expectedMessage);
  });

  it('rejects a name over 120 characters with 400', async () => {
    await postBatch(TENANT_A_KEY, { rules: [ruleItem('n'.repeat(121))] }).expect(400);
  });

  it('requires an authenticated tenant', async () => {
    await request(server())
      .post('/api/v1/rules/batch')
      .send({ rules: [ruleItem('Anonymous')] })
      .expect(401);
  });

  it('bounds the entry search term at 200 characters', async () => {
    await request(server())
      .get(`/api/v1/entries?search=${'s'.repeat(ENTRY_SEARCH_MAX_LENGTH)}`)
      .set('x-api-key', TENANT_A_KEY)
      .expect(200);

    const rejected = await request(server())
      .get(`/api/v1/entries?search=${'s'.repeat(ENTRY_SEARCH_MAX_LENGTH + 1)}`)
      .set('x-api-key', TENANT_A_KEY)
      .expect(400);

    expect(errorBody(rejected).code).toBe('entry_search_too_long');
  });
});

describeWithDatabase('migration 0020 and the rules uniqueness rule it installs', () => {
  let pool: Pool;
  let repository: RulesRepository;

  /** Every migration strictly before 0020: the state the dedupe has to be able to clean up. */
  async function applyMigrationsBefore0020(): Promise<void> {
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);

    for (const migration of await readMigrationFiles()) {
      if (migration.name >= '0020') {
        continue;
      }
      await pool.query(migration.sql);
    }
  }

  async function apply0020(): Promise<void> {
    const migration = (await readMigrationFiles()).find((file) => file.name.startsWith('0020'));

    if (!migration) {
      throw new Error('db/migrations/0020_rules_unique_tenant_name.sql is missing');
    }

    await pool.query(migration.sql);
  }

  async function insertRuleAt(tenantId: string, name: string, createdAt: string): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO rules (tenant_id, name, include_keywords, exclude_keywords, is_active, created_at)
       VALUES ($1, $2, ARRAY['ai']::text[], ARRAY[]::text[], true, $3)
       RETURNING id`,
      [tenantId, name, createdAt],
    );

    return expectDefined(result.rows[0]).id;
  }

  async function nameOf(id: number): Promise<string> {
    const result = await pool.query<{ name: string }>('SELECT name FROM rules WHERE id = $1', [id]);
    return expectDefined(result.rows[0]).name;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${TEST_SCHEMA}` });
    repository = new RulesRepository(new DatabaseService(pool));
  }, 60_000);

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  describe('dedupe', () => {
    let oldest: number;
    let middle: number;
    let newest: number;
    let alreadySuffixed: number;
    let otherTenant: number;
    let longOldest: number;
    let longLoser: number;

    const LONG_NAME = 'L'.repeat(120);

    beforeAll(async () => {
      await applyMigrationsBefore0020();

      oldest = await insertRuleAt('tenant_a', 'Evictions', '2026-01-01T00:00:00Z');
      middle = await insertRuleAt('tenant_a', 'Evictions', '2026-02-01T00:00:00Z');
      newest = await insertRuleAt('tenant_a', 'Evictions', '2026-03-01T00:00:00Z');
      // Already occupies the first suffix the rename would reach for.
      alreadySuffixed = await insertRuleAt('tenant_a', 'Evictions (2)', '2026-04-01T00:00:00Z');
      // Same name, different tenant: uniqueness is per tenant, so nothing here is a duplicate.
      otherTenant = await insertRuleAt('tenant_b', 'Evictions', '2026-01-15T00:00:00Z');
      longOldest = await insertRuleAt('tenant_a', LONG_NAME, '2026-01-01T00:00:00Z');
      longLoser = await insertRuleAt('tenant_a', LONG_NAME, '2026-05-01T00:00:00Z');

      await apply0020();
    }, 120_000);

    it('keeps the oldest row of each group under the original name', async () => {
      await expect(nameOf(oldest)).resolves.toBe('Evictions');
      await expect(nameOf(longOldest)).resolves.toBe(LONG_NAME);
    });

    it('renames the losers instead of deleting them, skipping suffixes already in use', async () => {
      // '(2)' is taken by `alreadySuffixed`, so the search continues from there.
      await expect(nameOf(middle)).resolves.toBe('Evictions (3)');
      await expect(nameOf(newest)).resolves.toBe('Evictions (4)');
    });

    it('leaves rows that were never duplicates alone, including other tenants', async () => {
      await expect(nameOf(alreadySuffixed)).resolves.toBe('Evictions (2)');
      await expect(nameOf(otherTenant)).resolves.toBe('Evictions');
    });

    it('deletes nothing: a rule row is user-authored configuration', async () => {
      const result = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM rules');

      expect(Number(expectDefined(result.rows[0]).count)).toBe(7);
    });

    it('keeps a renamed rule inside the 120-character API cap so it stays editable', async () => {
      const renamed = await nameOf(longLoser);

      expect(renamed).not.toBe(LONG_NAME);
      expect(renamed.length).toBeLessThanOrEqual(120);
      expect(renamed.endsWith(' (2)')).toBe(true);
    });

    it('installs the unique index and rejects a duplicate name afterwards', async () => {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_rules_tenant_name_unique'`,
        [TEST_SCHEMA],
      );
      expect(indexes.rowCount).toBe(1);

      await expect(insertRuleAt('tenant_a', 'Evictions', '2026-06-01T00:00:00Z')).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('is idempotent: applying 0020 twice changes nothing', async () => {
      await apply0020();

      await expect(nameOf(middle)).resolves.toBe('Evictions (3)');
      await expect(nameOf(newest)).resolves.toBe('Evictions (4)');
    });
  });

  describe('RulesRepository against real PostgreSQL', () => {
    beforeAll(async () => {
      await applyMigrationsBefore0020();
      await apply0020();
    }, 120_000);

    it('reports created and skipped exactly, with real ON CONFLICT DO NOTHING semantics', async () => {
      const first = await repository.insertIgnoreOnConflict(
        [
          { name: 'Alpha', includeKeywords: ['a'], excludeKeywords: [], isActive: true },
          { name: 'Beta', includeKeywords: ['b'], excludeKeywords: [], isActive: true },
        ],
        'tenant_pg',
      );
      expect(first.created.map((rule) => rule.name).sort()).toEqual(['Alpha', 'Beta']);
      expect(first.skippedNames).toEqual([]);

      const second = await repository.insertIgnoreOnConflict(
        [
          { name: 'Alpha', includeKeywords: ['overwritten'], excludeKeywords: [], isActive: false },
          { name: 'Gamma', includeKeywords: ['g'], excludeKeywords: [], isActive: true },
          { name: 'Gamma', includeKeywords: ['g-again'], excludeKeywords: [], isActive: true },
        ],
        'tenant_pg',
      );
      expect(second.created.map((rule) => rule.name)).toEqual(['Gamma']);
      expect(second.skippedNames).toEqual(['Alpha']);
      expect(second.duplicateNames).toEqual(['Gamma']);

      // The skipped rule is byte-for-byte what it was before the second batch.
      await expect(repository.findByName('Alpha', 'tenant_pg')).resolves.toMatchObject({
        includeKeywords: ['a'],
        isActive: true,
      });
    });

    it('upserts by name in one statement, preserving created_at on the update branch', async () => {
      const inserted = await repository.upsertByName({
        tenantId: 'tenant_pg_upsert',
        name: 'Recurring import',
        includeKeywords: ['first'],
        excludeKeywords: [],
        isActive: true,
      });

      const updated = await repository.upsertByName({
        tenantId: 'tenant_pg_upsert',
        name: 'Recurring import',
        includeKeywords: ['second'],
        excludeKeywords: ['not-this'],
        isActive: false,
      });

      expect(updated.id).toBe(inserted.id);
      expect(updated.createdAt).toBe(inserted.createdAt);
      expect(updated.includeKeywords).toEqual(['second']);
      expect(updated.excludeKeywords).toEqual(['not-this']);
      expect(updated.isActive).toBe(false);

      const all = await repository.list({ tenantId: 'tenant_pg_upsert', page: 1, pageSize: 50 });
      expect(all.total).toBe(1);
    });

    it('keeps a same-named rule in another tenant untouched when upserting', async () => {
      await repository.upsertByName({
        tenantId: 'tenant_pg_other',
        name: 'Recurring import',
        includeKeywords: ['other-tenant'],
        excludeKeywords: [],
        isActive: true,
      });

      await expect(repository.findByName('Recurring import', 'tenant_pg_other')).resolves.toMatchObject({
        includeKeywords: ['other-tenant'],
      });
      await expect(repository.findByName('Recurring import', 'tenant_pg_upsert')).resolves.toMatchObject({
        includeKeywords: ['second'],
      });
    });
  });
});
