import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../opml-imports/domain/url-normalizer';
import { Feed } from './domain/feed.entity';

type QueryExecutor = Pick<DatabaseService, 'query'>;

interface FeedRow {
  id: number;
  tenant_id: string;
  url: string;
  status: 'active' | 'paused' | 'error';
  etag: string | null;
  last_modified: string | null;
  last_checked_at: Date | null;
  next_check_at: Date;
  poll_interval_seconds: number;
  error_count: number;
  last_error: string | null;
  avg_response_ms: number | null;
  avg_items_per_day: number | null;
  claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Scheduling priority used both by the claim query (to decide which feeds win a limited
 * batch) and by the JS re-sort of the claimed rows: `UPDATE ... RETURNING` gives no
 * ordering guarantee, so the caller-visible order has to be re-established in memory.
 */
const CLAIM_PRIORITY_BY_STATUS: Record<FeedRow['status'], number> = {
  active: 0,
  error: 1,
  paused: 2,
};

/** Upper bound of the anti-thundering-herd jitter added to `next_check_at`, in seconds. */
const MAX_CLAIM_JITTER_SECONDS = 300;

/** Fraction of the poll interval used as the jitter window, capped by MAX_CLAIM_JITTER_SECONDS. */
const CLAIM_JITTER_RATIO = 0.2;

/** Marks feeds paused by the ingestion auto-pause path, which stay eligible for re-claiming. */
const AUTO_PAUSED_ERROR_PATTERN = 'auto-paused:%';

function mapFeed(row: FeedRow): Feed {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    status: row.status,
    etag: row.etag,
    lastModified: row.last_modified,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    nextCheckAt: row.next_check_at.toISOString(),
    pollIntervalSeconds: row.poll_interval_seconds,
    errorCount: row.error_count,
    lastError: row.last_error,
    avgResponseMs: row.avg_response_ms,
    avgItemsPerDay: row.avg_items_per_day,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class FeedsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: {
    tenantId: string;
    url: string;
    pollIntervalSeconds: number;
    status: 'active' | 'paused' | 'error';
  }): Promise<Feed> {
    const normalizedUrlHash = this.buildNormalizedUrlHashOrNull(input.url);

    try {
      const result = await this.databaseService.query<FeedRow>(
        `
          INSERT INTO feeds (tenant_id, url, normalized_url_hash, poll_interval_seconds, status, next_check_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          RETURNING *
        `,
        [input.tenantId, input.url, normalizedUrlHash, input.pollIntervalSeconds, input.status],
      );

      const row = result.rows[0];

      if (!row) {
        // `INSERT ... RETURNING *` always yields exactly one row. The guard is
        // here so the impossible case fails loudly instead of dereferencing
        // `undefined` somewhere downstream inside `mapFeed`.
        throw new Error('feed_insert_returned_no_row');
      }

      return mapFeed(row);
    } catch (error: unknown) {
      if (typeof error === 'object' && error && 'code' in error && error.code === '23505') {
        throw new ConflictException('feed_already_exists');
      }

      throw error;
    }
  }

  private buildNormalizedUrlHashOrNull(url: string): string | null {
    try {
      return buildNormalizedFeedUrlHash(normalizeFeedUrl(url));
    } catch {
      return null;
    }
  }

  async list(filters: {
    tenantId: string;
    status?: string;
    query?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: Feed[]; total: number }> {
    const where: string[] = [`tenant_id = $1`];
    const values: unknown[] = [filters.tenantId];

    if (filters.status) {
      where.push(`status = $${values.length + 1}`);
      values.push(filters.status);
    }

    if (filters.query) {
      where.push(`url ILIKE $${values.length + 1}`);
      values.push(`%${filters.query}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (filters.page - 1) * filters.pageSize;
    const listValues = [...values, filters.pageSize, offset];

    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<FeedRow>(
        `SELECT * FROM feeds ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        listValues,
      ),
      this.databaseService.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM feeds ${clause}`, values),
    ]);

    return {
      items: itemsResult.rows.map(mapFeed),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  /**
   * Atomically claims the next batch of due feeds.
   *
   * A single statement does the selection and the claim: the inner `SELECT ... FOR UPDATE
   * SKIP LOCKED` locks the chosen rows for the duration of the statement, so a second
   * scheduler replica running concurrently skips them and claims a disjoint batch instead
   * of handing the same feed to two workers.
   *
   * `next_check_at` is pushed forward here (not after the fetch) so a feed is never picked
   * up twice while its job is in flight; `claimed_at` is the compensating marker that lets
   * `releaseStuckFeeds` recover feeds whose worker died before clearing it.
   *
   * The jitter is computed per row inside SQL, so every feed in the batch gets its own
   * offset even when they share a poll interval.
   */
  async claimDueFeeds(limit: number): Promise<Feed[]> {
    if (limit <= 0) {
      throw new BadRequestException('scheduler_batch_size_invalid');
    }

    const claimed = await this.databaseService.query<FeedRow>(
      `
        UPDATE feeds
        SET next_check_at = NOW() + (
              (
                poll_interval_seconds
                + (RANDOM() * LEAST(${MAX_CLAIM_JITTER_SECONDS}, poll_interval_seconds * ${CLAIM_JITTER_RATIO}))::int
              )::text || ' seconds'
            )::interval,
            claimed_at = NOW(),
            updated_at = NOW()
        WHERE id IN (
          SELECT id
          FROM feeds
          WHERE next_check_at <= NOW()
            AND claimed_at IS NULL
            AND (
              status IN ('active', 'error')
              OR (status = 'paused' AND last_error LIKE $2)
            )
          ORDER BY CASE
                     WHEN status = 'active' THEN 0
                     WHEN status = 'error' THEN 1
                     ELSE 2
                   END,
                   next_check_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `,
      [limit, AUTO_PAUSED_ERROR_PATTERN],
    );

    return [...claimed.rows]
      .sort(
        (left, right) =>
          CLAIM_PRIORITY_BY_STATUS[left.status] - CLAIM_PRIORITY_BY_STATUS[right.status] || left.id - right.id,
      )
      .map(mapFeed);
  }

  /**
   * Releases feeds whose claim is older than the threshold: the worker that claimed them
   * crashed, was OOM-killed, or threw before `updateAfterFetch` could clear the marker.
   * They are made due again immediately so the next tick re-claims them.
   *
   * The threshold must stay above the worst-case job duration
   * (RATE_LIMIT_MAX_BACKOFF_MS + FETCH_TIMEOUT_MS); a lower value releases feeds that are
   * still being processed and causes duplicate fetches.
   */
  async releaseStuckFeeds(staleThresholdSeconds: number): Promise<number> {
    if (staleThresholdSeconds <= 0) {
      throw new BadRequestException('scheduler_stuck_threshold_invalid');
    }

    const result = await this.databaseService.query<{ id: number }>(
      `
        UPDATE feeds
        SET claimed_at = NULL,
            next_check_at = NOW(),
            updated_at = NOW()
        WHERE claimed_at IS NOT NULL
          AND claimed_at < NOW() - ($1::int || ' seconds')::interval
        RETURNING id
      `,
      [staleThresholdSeconds],
    );

    return result.rows.length;
  }

  /**
   * Whether a feed currently holds a scheduler claim. Used to reject a manual check while
   * a fetch for the same feed is already in flight, which bounds the unique-job-id path
   * that manual checks use to escape scheduler deduplication.
   *
   * `($2::text IS NULL OR tenant_id = $2)` is the deliberate escape hatch: passing NULL
   * disables the tenant predicate. It exists for scheduler/worker callers that hold a feed
   * id but no tenant context. Every HTTP path must pass a real tenant id.
   *
   * TODO(tenant-isolation): make `tenantId` required and route the unscoped reads through a
   * dedicated `isClaimedForWorker(id)`. Blocked only by `test/feeds-repository-claim.integration-spec.ts`,
   * which calls `isClaimed(feedId)` without a tenant; that file is outside this unit's edit scope.
   */
  async isClaimed(id: number, tenantId?: string): Promise<boolean> {
    const result = await this.databaseService.query<{ id: number }>(
      `
        SELECT id
        FROM feeds
        WHERE id = $1
          AND claimed_at IS NOT NULL
          AND ($2::text IS NULL OR tenant_id = $2)
      `,
      [id, tenantId ?? null],
    );

    return result.rows.length > 0;
  }

  /**
   * Feed lookup by id.
   *
   * The widening branch is no longer hidden inside this method: omitting `tenantId` routes to
   * `findByIdForWorker`, so `rg 'ForWorker'` enumerates the complete cross-tenant read surface
   * of the application. Every HTTP path passes a real tenant id and therefore lands on
   * `findByIdForTenant`.
   *
   * TODO(tenant-isolation): make `tenantId` required and let `ProcessFeedJobUseCase` call
   * `findByIdForWorker` directly. Blocked by `test/process-feed-job-matching.spec.ts`, which
   * fakes the repository with a bare `findById` key; that file is outside this unit's edit scope.
   */
  async findById(id: number, tenantId?: string): Promise<Feed | null> {
    return tenantId === undefined ? this.findByIdForWorker(id) : this.findByIdForTenant(id, tenantId);
  }

  /**
   * Tenant-scoped lookup with a REQUIRED tenant id. Feed ids are sequential and therefore
   * guessable, so this is the only form an HTTP-reachable path may use.
   */
  async findByIdForTenant(id: number, tenantId: string): Promise<Feed | null> {
    const result = await this.databaseService.query<FeedRow>('SELECT * FROM feeds WHERE id = $1 AND tenant_id = $2', [
      id,
      tenantId,
    ]);
    return result.rows[0] ? mapFeed(result.rows[0]) : null;
  }

  /**
   * Deliberately cross-tenant lookup for the ingestion worker, which is handed a feed id by
   * the scheduler and has no tenant context until it reads the row. Never reachable from an
   * HTTP handler: the only caller is `ProcessFeedJobUseCase`, and every query it issues
   * afterwards is scoped by the `tenant_id` carried on the row returned here.
   */
  async findByIdForWorker(id: number): Promise<Feed | null> {
    const result = await this.databaseService.query<FeedRow>('SELECT * FROM feeds WHERE id = $1', [id]);
    return result.rows[0] ? mapFeed(result.rows[0]) : null;
  }

  /** Tenant-scoped update. `tenantId` is REQUIRED; there is no cross-tenant update path. */
  async update(input: {
    tenantId: string;
    id: number;
    status?: 'active' | 'paused' | 'error';
    pollIntervalSeconds?: number;
  }): Promise<Feed | null> {
    const current = await this.findByIdForTenant(input.id, input.tenantId);

    if (!current) {
      return null;
    }

    const status = input.status ?? current.status;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? current.pollIntervalSeconds;
    let nextCheckAt = current.nextCheckAt;

    if (status === 'active' && current.status !== 'active') {
      nextCheckAt = new Date().toISOString();
    } else if (status === 'active' && pollIntervalSeconds !== current.pollIntervalSeconds) {
      nextCheckAt = new Date(Date.now() + pollIntervalSeconds * 1000).toISOString();
    }

    const result = await this.databaseService.query<FeedRow>(
      `
        UPDATE feeds
        SET status = $2,
            poll_interval_seconds = $3,
            next_check_at = $4,
            updated_at = NOW()
         WHERE id = $1
           AND tenant_id = $5
         RETURNING *
       `,
      [input.id, status, pollIntervalSeconds, nextCheckAt, input.tenantId],
    );

    return result.rows[0] ? mapFeed(result.rows[0]) : null;
  }

  /** Tenant-scoped disable. `tenantId` is REQUIRED; there is no cross-tenant disable path. */
  async disable(id: number, tenantId: string): Promise<boolean> {
    const updated = await this.update({ id, status: 'paused', tenantId });
    return Boolean(updated);
  }

  async updateAfterFetch(input: {
    feedId: number;
    etag?: string | null;
    lastModified?: string | null;
    status: 'active' | 'error' | 'paused';
    errorCount: number;
    lastError?: string | null;
    avgResponseMs?: number | null;
    nextCheckAt?: string;
    executor?: QueryExecutor;
  }): Promise<void> {
    const executor = input.executor ?? this.databaseService;
    await executor.query(
      `
        UPDATE feeds
        SET etag = COALESCE($2, etag),
            last_modified = COALESCE($3, last_modified),
            status = $4,
            error_count = $5,
            last_error = $6,
            avg_response_ms = COALESCE($7, avg_response_ms),
            last_checked_at = NOW(),
            next_check_at = $8,
            -- Released on both the success and the failure path: this is the only place
            -- the ingestion job reports back, so anything that skips it is by definition
            -- a crash and must be recovered by releaseStuckFeeds instead.
            claimed_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        input.feedId,
        input.etag ?? null,
        input.lastModified ?? null,
        input.status,
        input.errorCount,
        input.lastError ?? null,
        input.avgResponseMs ?? null,
        input.nextCheckAt ?? new Date().toISOString(),
      ],
    );
  }

  async countByStatus(status: 'active' | 'error'): Promise<number> {
    const result = await this.databaseService.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM feeds WHERE status = $1',
      [status],
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}
