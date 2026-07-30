import type { IMemoryDb } from 'pg-mem';
import { DataType, newDb } from 'pg-mem';
import type { DatabaseService } from '../src/infrastructure/persistence/database.service';
import type { ReadinessService } from '../src/infrastructure/persistence/readiness.service';
import type { ProcessTelegramDigestsUseCase } from '../src/modules/alerts/application/process-telegram-digests.use-case';
import { FeedsRepository } from '../src/modules/feeds/feeds.repository';
import type { StuckFeedSweepConfig } from '../src/modules/ingestion/application/release-stuck-feeds.use-case';
import {
  DEFAULT_STUCK_FEED_THRESHOLD_SECONDS,
  ReleaseStuckFeedsUseCase,
} from '../src/modules/ingestion/application/release-stuck-feeds.use-case';
import type { ScheduleDueFeedsUseCase } from '../src/modules/ingestion/application/schedule-due-feeds.use-case';
import { SchedulerRunner } from '../src/modules/ingestion/scheduler.runner';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { expectDefined } from './support/expect-defined';

interface TestPool {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

function createMemoryDb(): IMemoryDb {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({
    name: 'random',
    returns: DataType.float,
    implementation: () => Math.random(),
    impure: true,
  });
  return db;
}

function createReadinessService(): ReadinessService {
  return { assertSchemaReady: jest.fn().mockResolvedValue(undefined) } as unknown as ReadinessService;
}

async function bootstrapFeedsTable(pool: TestPool): Promise<void> {
  await pool.query(`
    CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      poll_interval_seconds INT NOT NULL DEFAULT 1800,
      last_error TEXT,
      claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function insertClaimedFeed(pool: TestPool, url: string, claimedSecondsAgo: number): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO feeds (url, next_check_at, claimed_at)
      VALUES ($1, NOW() + INTERVAL '1800 seconds', NOW() - ($2::int || ' seconds')::interval)
      RETURNING id
    `,
    [url, claimedSecondsAgo],
  );

  return expectDefined(result.rows[0]).id;
}

describe('ReleaseStuckFeedsUseCase', () => {
  let pool: TestPool;
  let repository: FeedsRepository;

  beforeEach(async () => {
    const db = createMemoryDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await bootstrapFeedsTable(pool);
    repository = new FeedsRepository(pool as unknown as DatabaseService);
  });

  function createUseCase(schedulerStuckFeedThresholdSeconds: number): ReleaseStuckFeedsUseCase {
    const sweepConfig: StuckFeedSweepConfig = { schedulerStuckFeedThresholdSeconds };
    return new ReleaseStuckFeedsUseCase(createReadinessService(), repository, sweepConfig);
  }

  it('releases and counts feeds claimed beyond the threshold, leaving fresher claims alone', async () => {
    const stuckId = await insertClaimedFeed(pool, 'https://stuck.example/rss', 900);
    const workingId = await insertClaimedFeed(pool, 'https://working.example/rss', 30);

    const result = await createUseCase(300).execute();

    expect(result.released).toBe(1);

    const rows = await pool.query<{ id: number; claimed_at: Date | null }>(
      'SELECT id, claimed_at FROM feeds ORDER BY id',
    );
    expect(rows.rows.find((row) => row.id === stuckId)?.claimed_at).toBeNull();
    expect(rows.rows.find((row) => row.id === workingId)?.claimed_at).toBeInstanceOf(Date);
  });

  it('makes a released feed due again so the next tick can re-claim it', async () => {
    await insertClaimedFeed(pool, 'https://stuck.example/rss', 900);

    await createUseCase(300).execute();

    const claimed = await repository.claimDueFeeds(10);
    expect(claimed).toHaveLength(1);
  });

  it('reports zero when nothing is stuck', async () => {
    await insertClaimedFeed(pool, 'https://working.example/rss', 10);

    const result = await createUseCase(300).execute();

    expect(result.released).toBe(0);
  });

  it('waits for schema readiness before sweeping', async () => {
    const readinessService = createReadinessService();
    const useCase = new ReleaseStuckFeedsUseCase(readinessService, repository, {
      schedulerStuckFeedThresholdSeconds: 300,
    });

    await useCase.execute();

    expect(readinessService.assertSchemaReady).toHaveBeenCalledTimes(1);
  });

  it('falls back to the documented default when the threshold is not configured', async () => {
    const releaseStuckFeeds = jest.spyOn(repository, 'releaseStuckFeeds').mockResolvedValue(0);
    const useCase = new ReleaseStuckFeedsUseCase(createReadinessService(), repository, {
      schedulerStuckFeedThresholdSeconds: undefined as unknown as number,
    });

    await useCase.execute();

    expect(releaseStuckFeeds).toHaveBeenCalledWith(DEFAULT_STUCK_FEED_THRESHOLD_SECONDS);
  });

  it('refuses a non-positive threshold that would release feeds still being fetched', async () => {
    const releaseStuckFeeds = jest.spyOn(repository, 'releaseStuckFeeds').mockResolvedValue(0);

    await createUseCase(0).execute();

    expect(releaseStuckFeeds).toHaveBeenCalledWith(DEFAULT_STUCK_FEED_THRESHOLD_SECONDS);
  });
});

describe('SchedulerRunner tick lifecycle', () => {
  let scheduleDueFeeds: { execute: jest.Mock };
  let releaseStuckFeeds: { execute: jest.Mock };
  let processTelegramDigests: { execute: jest.Mock };
  let intervalHandler: (() => void) | null;
  let setIntervalSpy: jest.SpyInstance;
  let runner: SchedulerRunner;

  beforeEach(() => {
    scheduleDueFeeds = { execute: jest.fn().mockResolvedValue({ scheduled: 0, deduplicated: 0 }) };
    releaseStuckFeeds = { execute: jest.fn().mockResolvedValue({ released: 0 }) };
    processTelegramDigests = { execute: jest.fn().mockResolvedValue({ processedGroups: 0, sentItems: 0 }) };
    intervalHandler = null;

    // Capturing the interval callback keeps the test off the clock entirely: ticks are driven
    // by calling the callback, so nothing depends on real or faked time passing.
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((handler: TimerHandler) => {
      intervalHandler = handler as () => void;
      return setTimeout(() => undefined, 0);
    });

    runner = new SchedulerRunner(
      scheduleDueFeeds as unknown as ScheduleDueFeedsUseCase,
      releaseStuckFeeds as unknown as ReleaseStuckFeedsUseCase,
      processTelegramDigests as unknown as ProcessTelegramDigestsUseCase,
      { schedulerTickMs: 1000 } as unknown as AppConfigService,
    );
  });

  afterEach(async () => {
    await runner.onApplicationShutdown();
    setIntervalSpy.mockRestore();
  });

  it('sweeps stuck feeds before claiming new ones', async () => {
    const callOrder: string[] = [];
    releaseStuckFeeds.execute.mockImplementation(async () => {
      callOrder.push('release');
      return { released: 0 };
    });
    scheduleDueFeeds.execute.mockImplementation(async () => {
      callOrder.push('schedule');
      return { scheduled: 0, deduplicated: 0 };
    });

    await runner.start();

    expect(callOrder).toEqual(['release', 'schedule']);
  });

  it('keeps ticking when the sweep fails', async () => {
    releaseStuckFeeds.execute.mockRejectedValue(new Error('database unavailable'));

    await expect(runner.start()).resolves.toBeUndefined();

    expect(scheduleDueFeeds.execute).toHaveBeenCalledTimes(1);
  });

  it('skips an interval while the previous tick is still running', async () => {
    let releaseSecondTick: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseSecondTick = resolve;
    });

    scheduleDueFeeds.execute
      .mockResolvedValueOnce({ scheduled: 0, deduplicated: 0 })
      .mockImplementationOnce(async () => {
        await blocked;
        return { scheduled: 0, deduplicated: 0 };
      });

    await runner.start();
    expect(intervalHandler).not.toBeNull();

    intervalHandler?.();
    intervalHandler?.();

    releaseSecondTick();
    await runner.onApplicationShutdown();

    // Three interval firings, two ticks: the third found the second still in flight.
    expect(scheduleDueFeeds.execute).toHaveBeenCalledTimes(2);
  });

  it('waits for the tick in flight before completing shutdown', async () => {
    let finished = false;
    let releaseTick: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });

    scheduleDueFeeds.execute
      .mockResolvedValueOnce({ scheduled: 0, deduplicated: 0 })
      .mockImplementationOnce(async () => {
        await blocked;
        finished = true;
        return { scheduled: 0, deduplicated: 0 };
      });

    await runner.start();
    intervalHandler?.();

    const shutdown = runner.onApplicationShutdown();
    releaseTick();
    await shutdown;

    expect(finished).toBe(true);
  });
});
