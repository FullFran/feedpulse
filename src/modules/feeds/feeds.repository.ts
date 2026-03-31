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
  created_at: Date;
  updated_at: Date;
}

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

  async create(input: { tenantId: string; url: string; pollIntervalSeconds: number; status: 'active' | 'paused' | 'error' }): Promise<Feed> {
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

      return mapFeed(result.rows[0]);
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

  async claimDueFeeds(limit: number): Promise<Feed[]> {
    if (limit <= 0) {
      throw new BadRequestException('scheduler_batch_size_invalid');
    }

    const dueFeeds = await this.databaseService.query<FeedRow>(
      `
        SELECT *
        FROM feeds
        WHERE next_check_at <= NOW()
          AND (
            status IN ('active', 'error')
            OR (status = 'paused' AND last_error LIKE 'auto-paused:%')
          )
        ORDER BY CASE
                   WHEN status = 'active' THEN 0
                   WHEN status = 'error' THEN 1
                   ELSE 2
                 END,
                 next_check_at ASC
        LIMIT $1
      `,
      [limit],
    );

    if (!dueFeeds.rows.length) {
      return [];
    }

    const scheduledNextCheck = new Map<number, Date>();

    for (const feed of dueFeeds.rows) {
      const intervalMs = feed.poll_interval_seconds * 1000;
      const jitterWindowMs = Math.min(5 * 60 * 1000, Math.floor(intervalMs * 0.2));
      const jitterMs = jitterWindowMs > 0 ? Math.floor(Math.random() * jitterWindowMs) : 0;
      const nextCheckAtDate = new Date(Date.now() + intervalMs + jitterMs);
      const nextCheckAt = nextCheckAtDate.toISOString();
      scheduledNextCheck.set(feed.id, nextCheckAtDate);
      await this.databaseService.query(
        `
          UPDATE feeds
          SET next_check_at = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [feed.id, nextCheckAt],
      );
    }

    return dueFeeds.rows.map((row) =>
      mapFeed({
        ...row,
        next_check_at: scheduledNextCheck.get(row.id) ?? new Date(Date.now() + row.poll_interval_seconds * 1000),
        updated_at: new Date(),
      }),
    );
  }

  async findById(id: number, tenantId?: string): Promise<Feed | null> {
    const result = tenantId
      ? await this.databaseService.query<FeedRow>('SELECT * FROM feeds WHERE id = $1 AND tenant_id = $2', [id, tenantId])
      : await this.databaseService.query<FeedRow>('SELECT * FROM feeds WHERE id = $1', [id]);
    return result.rows[0] ? mapFeed(result.rows[0]) : null;
  }

  async update(input: { tenantId?: string; id: number; status?: 'active' | 'paused' | 'error'; pollIntervalSeconds?: number }): Promise<Feed | null> {
    const current = await this.findById(input.id, input.tenantId);

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
           AND ($5::text IS NULL OR tenant_id = $5)
         RETURNING *
       `,
      [input.id, status, pollIntervalSeconds, nextCheckAt, input.tenantId ?? null],
    );

    return result.rows[0] ? mapFeed(result.rows[0]) : null;
  }

  async disable(id: number, tenantId?: string): Promise<boolean> {
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
    const result = await this.databaseService.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM feeds WHERE status = $1', [status]);
    return Number(result.rows[0]?.count ?? '0');
  }
}
