import { BadRequestException } from '@nestjs/common';
import type { IMemoryDb } from 'pg-mem';
import { DataType, newDb } from 'pg-mem';
import type { DatabaseService } from '../src/infrastructure/persistence/database.service';
import { FeedsRepository } from '../src/modules/feeds/feeds.repository';
import { expectDefined } from './support/expect-defined';

/**
 * Anti-thundering-herd jitter added on claim: min(300s, 20% of the poll interval).
 * Mirrors the constants in FeedsRepository so the bounds assertion stays honest.
 */
const MAX_JITTER_SECONDS = 300;
const JITTER_RATIO = 0.2;

function expectedJitterWindowSeconds(pollIntervalSeconds: number): number {
  return Math.min(MAX_JITTER_SECONDS, pollIntervalSeconds * JITTER_RATIO);
}

interface TestPool {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

function createMemoryDb(): IMemoryDb {
  // pg-mem parses `FOR UPDATE SKIP LOCKED` but has no row locking to apply to it, so the AST
  // coverage check has to be relaxed; `random()` is not implemented natively either.
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: 'random',
    returns: DataType.float,
    implementation: () => Math.random(),
    impure: true,
  });
  return db;
}

async function bootstrapFeedsTable(pool: TestPool): Promise<void> {
  await pool.query(`
    CREATE TABLE feeds (
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
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function insertFeed(
  pool: TestPool,
  feed: {
    url: string;
    status?: 'active' | 'paused' | 'error';
    lastError?: string | null;
    pollIntervalSeconds?: number;
    dueOffsetSeconds?: number;
    claimedSecondsAgo?: number | null;
  },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO feeds (url, status, last_error, poll_interval_seconds, next_check_at, claimed_at)
      VALUES (
        $1,
        $2,
        $3,
        $4,
        NOW() - ($5::int || ' seconds')::interval,
        CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - ($6::int || ' seconds')::interval END
      )
      RETURNING id
    `,
    [
      feed.url,
      feed.status ?? 'active',
      feed.lastError ?? null,
      feed.pollIntervalSeconds ?? 1800,
      feed.dueOffsetSeconds ?? 60,
      feed.claimedSecondsAgo ?? null,
    ],
  );

  return expectDefined(result.rows[0]).id;
}

describe('FeedsRepository claim and sweep', () => {
  let pool: TestPool;
  let repository: FeedsRepository;

  beforeEach(async () => {
    const db = createMemoryDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await bootstrapFeedsTable(pool);
    repository = new FeedsRepository(pool as unknown as DatabaseService);
  });

  it('rejects a non-positive batch size instead of claiming the whole table', async () => {
    await expect(repository.claimDueFeeds(0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(repository.claimDueFeeds(-1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('orders the claimed batch active before error before auto-paused', async () => {
    const autoPausedId = await insertFeed(pool, {
      url: 'https://paused.example/rss',
      status: 'paused',
      lastError: 'auto-paused: dns',
    });
    const errorId = await insertFeed(pool, { url: 'https://error.example/rss', status: 'error', lastError: 'timeout' });
    const activeId = await insertFeed(pool, { url: 'https://active.example/rss', status: 'active' });

    const claimed = await repository.claimDueFeeds(10);

    expect(claimed.map((feed) => feed.id)).toEqual([activeId, errorId, autoPausedId]);
  });

  it('claims a paused feed only when it was auto-paused by the ingestion pipeline', async () => {
    const autoPausedId = await insertFeed(pool, {
      url: 'https://auto.example/rss',
      status: 'paused',
      lastError: 'auto-paused: could not resolve host',
    });
    await insertFeed(pool, { url: 'https://manual.example/rss', status: 'paused', lastError: null });
    await insertFeed(pool, {
      url: 'https://terminal.example/rss',
      status: 'paused',
      lastError: 'Feed fetch failed with status 404',
    });

    const claimed = await repository.claimDueFeeds(10);

    expect(claimed.map((feed) => feed.id)).toEqual([autoPausedId]);
  });

  it('marks claimed feeds so a second scheduler pass cannot take them again', async () => {
    await insertFeed(pool, { url: 'https://active.example/rss' });

    const firstPass = await repository.claimDueFeeds(10);
    expect(firstPass).toHaveLength(1);

    const claimedRows = await pool.query<{ claimed_at: Date | null }>('SELECT claimed_at FROM feeds');
    expect(expectDefined(claimedRows.rows[0]).claimed_at).toBeInstanceOf(Date);

    const secondPass = await repository.claimDueFeeds(10);
    expect(secondPass).toEqual([]);
  });

  it('honours the batch size, taking the highest priority feeds first', async () => {
    await insertFeed(pool, { url: 'https://error-a.example/rss', status: 'error', lastError: 'timeout' });
    const activeId = await insertFeed(pool, { url: 'https://active.example/rss', status: 'active' });

    const claimed = await repository.claimDueFeeds(1);

    expect(claimed.map((feed) => feed.id)).toEqual([activeId]);
  });

  it('pushes next_check_at one poll interval forward plus a bounded jitter', async () => {
    const pollIntervalSeconds = 300;
    await insertFeed(pool, { url: 'https://active.example/rss', pollIntervalSeconds });

    const claimedAtMs = Date.now();
    const [claimed] = await repository.claimDueFeeds(10);

    // Bounds, never exact values: the jitter comes from RANDOM() by design.
    const nextCheckMs = new Date(expectDefined(claimed).nextCheckAt).getTime();
    const lowerBoundMs = claimedAtMs + pollIntervalSeconds * 1000;
    const upperBoundMs = claimedAtMs + (pollIntervalSeconds + expectedJitterWindowSeconds(pollIntervalSeconds)) * 1000;
    const toleranceMs = 5_000;

    expect(nextCheckMs).toBeGreaterThanOrEqual(lowerBoundMs - toleranceMs);
    expect(nextCheckMs).toBeLessThanOrEqual(upperBoundMs + toleranceMs);
  });

  it('gives feeds sharing a poll interval independent next_check_at values', async () => {
    const urls = Array.from({ length: 12 }, (_, index) => `https://feed-${index}.example/rss`);
    for (const url of urls) {
      await insertFeed(pool, { url, pollIntervalSeconds: 1800 });
    }

    const claimed = await repository.claimDueFeeds(urls.length);
    const distinctNextChecks = new Set(claimed.map((feed) => feed.nextCheckAt));

    // Per-row jitter: a single shared offset would collapse all of these into one value.
    expect(distinctNextChecks.size).toBeGreaterThan(1);
  });

  it('releases only claims older than the stuck threshold', async () => {
    const stuckId = await insertFeed(pool, { url: 'https://stuck.example/rss', claimedSecondsAgo: 900 });
    const workingId = await insertFeed(pool, { url: 'https://working.example/rss', claimedSecondsAgo: 30 });

    const released = await repository.releaseStuckFeeds(300);

    expect(released).toBe(1);

    const rows = await pool.query<{ id: number; claimed_at: Date | null }>(
      'SELECT id, claimed_at FROM feeds ORDER BY id',
    );
    expect(rows.rows.find((row) => row.id === stuckId)?.claimed_at).toBeNull();
    expect(rows.rows.find((row) => row.id === workingId)?.claimed_at).toBeInstanceOf(Date);
  });

  it('makes released feeds immediately claimable again', async () => {
    await insertFeed(pool, { url: 'https://stuck.example/rss', claimedSecondsAgo: 900, dueOffsetSeconds: -3600 });

    expect(await repository.claimDueFeeds(10)).toEqual([]);

    await repository.releaseStuckFeeds(300);

    const claimed = await repository.claimDueFeeds(10);
    expect(claimed).toHaveLength(1);
  });

  it('rejects a non-positive stuck threshold that would release feeds still being fetched', async () => {
    await expect(repository.releaseStuckFeeds(0)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the claim when the fetch reports back, on success and on failure', async () => {
    const feedId = await insertFeed(pool, { url: 'https://active.example/rss' });
    await repository.claimDueFeeds(10);

    await repository.updateAfterFetch({
      feedId,
      status: 'active',
      errorCount: 0,
      lastError: null,
      nextCheckAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await repository.isClaimed(feedId, 'legacy')).toBe(false);

    await repository.claimDueFeeds(10);
    await repository.updateAfterFetch({
      feedId,
      status: 'error',
      errorCount: 1,
      lastError: 'timeout',
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await repository.isClaimed(feedId, 'legacy')).toBe(false);
  });

  it('reports a claim only for the owning tenant', async () => {
    const feedId = await insertFeed(pool, { url: 'https://active.example/rss' });
    await repository.claimDueFeeds(10);

    expect(await repository.isClaimed(feedId, 'legacy')).toBe(true);
    expect(await repository.isClaimed(feedId, 'other-tenant')).toBe(false);
  });
});
