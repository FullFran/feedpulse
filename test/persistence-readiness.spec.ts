import { ServiceUnavailableException } from '@nestjs/common';
import type { QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { DatabaseService } from '../src/infrastructure/persistence/database.service';
import { ReadinessService } from '../src/infrastructure/persistence/readiness.service';

/**
 * Regression coverage for the readiness probe's schema resolution.
 *
 * The probe used to ask `information_schema.tables WHERE table_schema = 'public'`,
 * while every repository in this codebase addresses its tables unqualified and
 * therefore resolves them through the connection's `search_path`. The two only
 * agree when the app happens to run in `public`, so the probe could report ready
 * for a connection that cannot see a single table — which is exactly how
 * `test/vertical-slice.integration-spec.ts` (which owns a non-public schema) was
 * able to pass while asserting nothing about its own schema.
 */

function stubDatabaseService(rows: QueryResultRow[], onQuery?: (sql: string) => void): DatabaseService {
  return {
    query: (sql: string) => {
      onQuery?.(sql);
      return Promise.resolve({ rows } as unknown as QueryResult);
    },
  } as unknown as DatabaseService;
}

describe('ReadinessService.assertSchemaReady', () => {
  it('resolves when the base schema is visible to the connection', async () => {
    const service = new ReadinessService(stubDatabaseService([{ exists: true }]));

    await expect(service.assertSchemaReady()).resolves.toBeUndefined();
  });

  it('throws ServiceUnavailableException when the base schema is not visible', async () => {
    const service = new ReadinessService(stubDatabaseService([{ exists: false }]));

    await expect(service.assertSchemaReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.assertSchemaReady()).rejects.toThrow(
      'Persistence readiness error: base schema is not applied',
    );
  });

  it('throws when the probe returns no row at all', async () => {
    const service = new ReadinessService(stubDatabaseService([]));

    await expect(service.assertSchemaReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not pin the lookup to a hardcoded schema name', async () => {
    let executed = '';
    const service = new ReadinessService(
      stubDatabaseService([{ exists: true }], (sql) => {
        executed = sql;
      }),
    );

    await service.assertSchemaReady();

    // The invariant is "resolve the same way the repositories do", i.e. through
    // search_path. Any literal schema name here reintroduces the divergence.
    expect(executed).not.toMatch(/'public'/);
    expect(executed).toContain('to_regclass');
  });
});

/**
 * The behavioural half of the regression: it needs a real server because
 * `search_path` resolution is the thing under test and no in-memory emulator
 * reproduces it faithfully. Runs in CI, which sets TEST_DATABASE_URL.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('ReadinessService against a real Postgres', () => {
  // Suffixed so this suite can share a database with the other integration
  // suites, including under a parallel jest run.
  const suffix = Math.random().toString(36).slice(2, 10);
  const populatedSchema = `readiness_present_${suffix}`;
  const emptySchema = `readiness_absent_${suffix}`;

  let adminPool: Pool;
  const pools: Pool[] = [];
  let createdPublicDecoy = false;

  function poolForSchema(schema: string): Pool {
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${populatedSchema}`);
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${emptySchema}`);
    await adminPool.query(`CREATE TABLE ${populatedSchema}.feeds (id BIGINT PRIMARY KEY)`);

    // A decoy in `public` so the "not visible" case below is decisive: the old
    // implementation would have reported ready off this table alone. Only
    // created when `public.feeds` is absent, and only dropped if we created it,
    // so a sibling suite's real table is never disturbed.
    const existing = await adminPool.query<{ exists: boolean }>(
      `SELECT to_regclass('public.feeds') IS NOT NULL AS exists`,
    );

    if (!existing.rows[0]?.exists) {
      await adminPool.query('CREATE TABLE public.feeds (id BIGINT PRIMARY KEY)');
      createdPublicDecoy = true;
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));

    if (adminPool) {
      if (createdPublicDecoy) {
        await adminPool.query('DROP TABLE IF EXISTS public.feeds');
      }
      await adminPool.query(`DROP SCHEMA IF EXISTS ${populatedSchema} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${emptySchema} CASCADE`);
      await adminPool.end();
    }
  });

  it('reports ready for a connection scoped to a schema that has the base tables', async () => {
    const service = new ReadinessService(new DatabaseService(poolForSchema(populatedSchema)));

    await expect(service.assertSchemaReady()).resolves.toBeUndefined();
  });

  it('reports not ready for a connection that cannot see the base tables, even though public.feeds exists', async () => {
    const service = new ReadinessService(new DatabaseService(poolForSchema(emptySchema)));

    await expect(service.assertSchemaReady()).rejects.toThrow(
      'Persistence readiness error: base schema is not applied',
    );
  });

  it('follows the search_path rather than any single schema', async () => {
    // Same server, same user, same tables: only the search_path differs, and the
    // probe must swing with it.
    const visible = new ReadinessService(new DatabaseService(poolForSchema(`${emptySchema},${populatedSchema}`)));
    const hidden = new ReadinessService(new DatabaseService(poolForSchema(emptySchema)));

    await expect(visible.assertSchemaReady()).resolves.toBeUndefined();
    await expect(hidden.assertSchemaReady()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
