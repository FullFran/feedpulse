import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { DatabaseService } from '../src/infrastructure/persistence/database.service';
import {
  DEAD_LETTER_MAX_PAYLOAD_BYTES,
  DeadLetterRepository,
} from '../src/infrastructure/queue/dead-letter.repository';
import { expectDefined } from './support/expect-defined';
import { createPgMemPool } from './support/pg-mem';
import type { PgMemPool } from './support/pg-mem';
import { resetSchemaWithMigrations } from './support/schema';

const MIGRATION_FILE = join(__dirname, '..', 'db', 'migrations', '0019_dead_letter_jobs.sql');

const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function asDatabaseService(pool: { query: (text: string, values?: unknown[]) => Promise<unknown> }): DatabaseService {
  return { query: (text: string, values?: unknown[]) => pool.query(text, values) } as unknown as DatabaseService;
}

beforeAll(() => {
  // The repository logs its retention outcome; keep the suite output readable.
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

/**
 * The emulator half: runs against the REAL text of 0019, so a typo in the
 * migration fails here and not first in production. Everything asserted below is
 * plain DDL and plain DML, which is what pg-mem is trustworthy for.
 */
describe('dead_letter_jobs under pg-mem', () => {
  let pool: PgMemPool;
  let repository: DeadLetterRepository;

  beforeEach(async () => {
    pool = createPgMemPool().pool;
    await pool.query(await readFile(MIGRATION_FILE, 'utf8'));
    repository = new DeadLetterRepository(asDatabaseService(pool));
  });

  it('applies migration 0019 and round-trips a recorded job', async () => {
    await repository.record({
      queue: 'fetch-feed',
      jobId: 'feed-7',
      payload: { feedId: 7, queuedAt: '2026-07-30T00:00:00.000Z', attempt: 3 },
      error: 'ETIMEDOUT',
      attempts: 3,
    });

    const recorded = await repository.listRecent('fetch-feed', 10);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      queue: 'fetch-feed',
      jobId: 'feed-7',
      error: 'ETIMEDOUT',
      attempts: 3,
    });
    expect(expectDefined(recorded[0]).payload).toEqual({ feedId: 7, queuedAt: '2026-07-30T00:00:00.000Z', attempt: 3 });
    expect(Number.isNaN(Date.parse(expectDefined(recorded[0]).failedAt))).toBe(false);
  });

  it('filters by queue and reads across every queue when asked for all of them', async () => {
    await repository.record({ queue: 'fetch-feed', jobId: 'feed-1', payload: {}, error: null, attempts: 3 });
    await repository.record({ queue: 'alert-delivery', jobId: 'alert-1', payload: {}, error: null, attempts: 4 });

    await expect(repository.listRecent('alert-delivery', 10)).resolves.toHaveLength(1);
    await expect(repository.listRecent(null, 10)).resolves.toHaveLength(2);
  });

  it('stores a truncation marker instead of a multi-megabyte OPML document', async () => {
    await repository.record({
      queue: 'opml-parse-preview',
      jobId: 'opml-1',
      payload: { importId: 1, opmlXml: 'x'.repeat(DEAD_LETTER_MAX_PAYLOAD_BYTES * 3) },
      error: 'parse_failed',
      attempts: 3,
    });

    const [recorded] = await repository.listRecent('opml-parse-preview', 1);
    const payload = expectDefined(recorded).payload as { truncated?: boolean; reason?: string };

    expect(payload.truncated).toBe(true);
    expect(payload.reason).toBe('payload_too_large');
  });

  it('keeps a null error null rather than coercing it to a string', async () => {
    await repository.record({ queue: 'fetch-feed', jobId: 'feed-1', payload: { feedId: 1 }, error: null, attempts: 1 });

    const [recorded] = await repository.listRecent('fetch-feed', 1);
    expect(expectDefined(recorded).error).toBeNull();
  });
});

/**
 * The real-PostgreSQL half. It exists for the two things pg-mem cannot vouch for:
 * that the migration applies in sequence with 0001-0018 through the production
 * runner path, and that the retention DELETE actually matches on an interval
 * comparison. Point `TEST_DATABASE_URL` at a throwaway database; it skips otherwise.
 */
describeWithDatabase('dead_letter_jobs against a real PostgreSQL', () => {
  let pool: Pool;
  let repository: DeadLetterRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await resetSchemaWithMigrations(pool, 'public');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE dead_letter_jobs RESTART IDENTITY');
    repository = new DeadLetterRepository(asDatabaseService(pool));
  });

  it('creates the table and both indexes the migration declares', async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'dead_letter_jobs' ORDER BY indexname`,
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['idx_dead_letter_jobs_failed_at', 'idx_dead_letter_jobs_queue_failed_at']),
    );
  });

  it('stores the payload as queryable JSONB, not as an opaque string', async () => {
    await repository.record({
      queue: 'alert-delivery',
      jobId: 'alert-42',
      payload: { alertId: 42, source: 'ingestion' },
      error: 'webhook_unreachable',
      attempts: 4,
    });

    const result = await pool.query<{ alert_id: string }>(
      `SELECT payload->>'alertId' AS alert_id FROM dead_letter_jobs WHERE job_id = $1`,
      ['alert-42'],
    );

    expect(expectDefined(result.rows[0]).alert_id).toBe('42');
  });

  it('returns the newest dead letter first', async () => {
    await pool.query(
      `INSERT INTO dead_letter_jobs (queue, job_id, payload, error, attempts, failed_at) VALUES
         ('fetch-feed', 'old', '{}'::jsonb, 'a', 3, NOW() - INTERVAL '2 hours'),
         ('fetch-feed', 'new', '{}'::jsonb, 'b', 3, NOW())`,
    );

    const recorded = await repository.listRecent('fetch-feed', 10);

    expect(recorded.map((row) => row.jobId)).toEqual(['new', 'old']);
  });

  it('purges rows past the retention window and keeps everything inside it', async () => {
    await pool.query(
      `INSERT INTO dead_letter_jobs (queue, job_id, payload, error, attempts, failed_at) VALUES
         ('fetch-feed', 'ancient', '{}'::jsonb, 'a', 3, NOW() - INTERVAL '31 days'),
         ('fetch-feed', 'recent',  '{}'::jsonb, 'b', 3, NOW() - INTERVAL '29 days')`,
    );

    await expect(repository.purgeOlderThan(30)).resolves.toBe(1);

    const survivors = await repository.listRecent('fetch-feed', 10);
    expect(survivors.map((row) => row.jobId)).toEqual(['recent']);
  });

  it('reads BIGSERIAL ids back as strings, so ids past 2^53 survive the round trip', async () => {
    await repository.record({ queue: 'fetch-feed', jobId: 'feed-1', payload: {}, error: null, attempts: 3 });

    const [recorded] = await repository.listRecent('fetch-feed', 1);
    expect(typeof expectDefined(recorded).id).toBe('string');
  });
});
