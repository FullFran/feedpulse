import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';

type QueryExecutor = Pick<DatabaseService, 'query'>;

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface Entry {
  id: string;
  feedId: number;
  title: string | null;
  link: string | null;
  guid: string | null;
  content: string | null;
  contentHash: string;
  publishedAt: string | null;
  fetchedAt: string;
}

interface EntryRow {
  id: string;
  tenant_id: string;
  feed_id: number;
  title: string | null;
  link: string | null;
  guid: string | null;
  content: string | null;
  content_hash: string;
  published_at: Date | null;
  fetched_at: Date;
}

interface EntryFilterRow {
  id: string;
  tenant_id: string;
  feed_id: number;
  title: string | null;
  content: string | null;
  published_at: Date | null;
}

export interface EntryFilterCandidate {
  id: string;
  feedId: number;
  title: string | null;
  content: string | null;
  publishedAt: string | null;
}

function mapEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    feedId: row.feed_id,
    title: row.title,
    link: row.link,
    guid: row.guid,
    content: row.content,
    contentHash: row.content_hash,
    publishedAt: row.published_at?.toISOString() ?? null,
    fetchedAt: row.fetched_at.toISOString(),
  };
}

@Injectable()
export class EntriesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async insertMany(
    tenantId: string,
    feedId: number,
    entries: Array<{
      title: string | null;
      link: string | null;
      guid: string | null;
      content: string | null;
      contentHash: string;
      publishedAt: string | null;
    }>,
    executor: QueryExecutor = this.databaseService,
  ): Promise<Entry[]> {
    const created: Entry[] = [];

    for (const entry of entries) {
      const result = await executor.query<EntryRow>(
        `
          INSERT INTO entries (tenant_id, feed_id, title, link, guid, content, content_hash, published_at, normalized_search_document)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, LOWER($9))
          ON CONFLICT DO NOTHING
          RETURNING id, feed_id, title, link, guid, content, content_hash, published_at, fetched_at
        `,
        [
          tenantId,
          feedId,
          entry.title,
          entry.link,
          entry.guid,
          entry.content,
          entry.contentHash,
          entry.publishedAt,
          normalizeSearchText(`${entry.title ?? ''} ${entry.content ?? ''}`),
        ],
      );

      if (result.rows[0]) {
        created.push(mapEntry(result.rows[0]));
      }
    }

    return created;
  }

  async list(input: {
    tenantId: string;
    page: number;
    pageSize: number;
    feedId?: number;
    search?: string;
    from?: string;
    to?: string;
  }): Promise<{ items: Entry[]; total: number }> {
    const where: string[] = [`tenant_id = $1`];
    const values: unknown[] = [input.tenantId];

    if (input.feedId) {
      where.push(`feed_id = $${values.length + 1}`);
      values.push(input.feedId);
    }

    if (input.search) {
      where.push(`normalized_search_document ILIKE $${values.length + 1}`);
      values.push(`%${normalizeSearchText(input.search)}%`);
    }

    if (input.from) {
      where.push(`COALESCE(published_at, fetched_at) >= $${values.length + 1}::timestamptz`);
      values.push(input.from);
    }

    if (input.to) {
      where.push(`COALESCE(published_at, fetched_at) <= $${values.length + 1}::timestamptz`);
      values.push(input.to);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;
    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<EntryRow>(
        `SELECT id, feed_id, title, link, guid, content, content_hash, published_at, fetched_at FROM entries ${clause} ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, input.pageSize, offset],
      ),
      this.databaseService.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM entries ${clause}`, values),
    ]);

    return {
      items: itemsResult.rows.map(mapEntry),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  async listForFilterSearch(limit: number, tenantId?: string): Promise<EntryFilterCandidate[]> {
    const cappedLimit = Math.max(1, Math.min(limit, 5000));
    const result = tenantId
      ? await this.databaseService.query<EntryFilterRow>(
      `
        SELECT id, tenant_id, feed_id, title, content, published_at
        FROM entries
        WHERE tenant_id = $2
        ORDER BY published_at DESC NULLS LAST, id DESC
        LIMIT $1
      `,
      [cappedLimit, tenantId],
    )
      : await this.databaseService.query<EntryFilterRow>(
      `
        SELECT id, tenant_id, feed_id, title, content, published_at
        FROM entries
        ORDER BY published_at DESC NULLS LAST, id DESC
        LIMIT $1
      `,
      [cappedLimit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      feedId: row.feed_id,
      title: row.title,
      content: row.content,
      publishedAt: row.published_at?.toISOString() ?? null,
    }));
  }
}
