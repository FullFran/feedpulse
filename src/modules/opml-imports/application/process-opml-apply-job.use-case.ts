import { Inject, Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../../../infrastructure/persistence/database.service';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { FETCH_FEED_QUEUE_TOKEN, FetchFeedQueuePort, OpmlApplyImportJobData } from '../../../infrastructure/queue/queue.constants';

import { assertValidOpmlImportStatusTransition } from '../domain/opml-import-status';
import { buildNormalizedFeedUrlHash } from '../domain/url-normalizer';
import { normalizeFeedUrl } from '../domain/url-normalizer';
import { OpmlImportObservabilityService } from './opml-import-observability.service';
import { OpmlImportsRepository } from '../opml-imports.repository';

interface FeedUpsertRow {
  id: number;
  url: string;
}

@Injectable()
export class ProcessOpmlApplyJobUseCase {
  private readonly logger = new Logger(ProcessOpmlApplyJobUseCase.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly opmlImportsRepository: OpmlImportsRepository,
    @Inject(FETCH_FEED_QUEUE_TOKEN) private readonly fetchFeedQueue: FetchFeedQueuePort,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
    private readonly observabilityService: OpmlImportObservabilityService,
  ) {}

  async execute(job: OpmlApplyImportJobData): Promise<void> {
    const current = await this.opmlImportsRepository.getImportOrThrow(job.importId);
    if (current.status === 'completed') {
      return;
    }

    if (current.status !== 'importing') {
      assertValidOpmlImportStatusTransition(current.status, 'importing');
      await this.opmlImportsRepository.markImportStatus(job.importId, { status: 'importing', confirmed: true });
    }

    const stopTimer = this.observabilityService.startJobTimer('apply');

    const client = await this.databaseService.getPool().connect();
    try {
      await client.query('BEGIN');

      const candidates = await this.opmlImportsRepository.listNewCandidateItems(job.importId, client);
      let importedItems = 0;
      let failedItems = 0;
      const createdFeedIds: number[] = [];

      for (const item of candidates) {
        if (!item.normalizedUrl) {
          await this.opmlImportsRepository.markItemFailed(Number(item.id), 'missing_normalized_url', client);
          failedItems += 1;
          continue;
        }

        try {
          const upsert = await this.upsertFeed(item.normalizedUrl, client);
          if (upsert.collision) {
            await this.opmlImportsRepository.markItemFailed(Number(item.id), 'normalized_hash_collision_detected', client);
            failedItems += 1;
            continue;
          }

          await this.opmlImportsRepository.markItemImported(Number(item.id), upsert.feedId, client);
          if (upsert.created) {
            createdFeedIds.push(upsert.feedId);
          }
          importedItems += 1;
        } catch (error) {
          await this.opmlImportsRepository.markItemFailed(
            Number(item.id),
            error instanceof Error ? error.message : 'opml_apply_item_failed',
            client,
          );
          failedItems += 1;
        }
      }

      const grouped = await this.opmlImportsRepository.countItemsByStatus(job.importId, client);
      const finalStatus = failedItems > 0 ? 'failed' : 'completed';
      const errorMessage = failedItems > 0 ? `partial_import_failure:${failedItems}` : null;

      await this.opmlImportsRepository.markImportStatus(
        job.importId,
        {
          status: finalStatus,
          errorMessage,
          completed: true,
          counters: {
            importedItems,
            invalidItems: grouped.invalid ?? 0,
            duplicateItems: grouped.duplicate ?? 0,
            existingItems: grouped.existing ?? 0,
            validItems: (grouped.new ?? 0) + (grouped.existing ?? 0) + (grouped.duplicate ?? 0) + (grouped.imported ?? 0),
            totalItems: Object.values(grouped).reduce((sum, value) => sum + value, 0),
          },
        },
        client,
      );

      await client.query('COMMIT');
      stopTimer('success');

      for (const feedId of createdFeedIds) {
        await this.fetchFeedQueue.enqueue({
          feedId,
          queuedAt: new Date().toISOString(),
          attempt: 0,
        });
      }
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : 'opml_apply_failed';
      this.logger.error(`OPML apply failed for import ${job.importId}: ${message}`);
      await this.opmlImportsRepository.markImportStatus(job.importId, {
        status: 'failed',
        errorMessage: message,
      });
      stopTimer('error', 'apply_failed');
    } finally {
      client.release();
    }
  }

  private async upsertFeed(normalizedUrl: string, executor: Pick<DatabaseService, 'query'>): Promise<{ feedId: number; created: boolean; collision: boolean }> {
    const normalizedHash = buildNormalizedFeedUrlHash(normalizedUrl);

    const jitterSeconds = Math.floor(Math.random() * Math.max(1, this.appConfigService.opmlInitialJitterMaxSeconds));
    const insertResult = await executor.query<FeedUpsertRow>(
      `
        INSERT INTO feeds (url, normalized_url_hash, poll_interval_seconds, status, next_check_at)
        VALUES ($1, $2, 1800, 'active', NOW() + ($3::text || ' seconds')::interval)
        ON CONFLICT (normalized_url_hash) DO NOTHING
        RETURNING id, url
      `,
      [normalizedUrl, normalizedHash, jitterSeconds],
    );

    if (insertResult.rows[0]) {
      return { feedId: insertResult.rows[0].id, created: true, collision: false };
    }

    const existingResult = await executor.query<FeedUpsertRow>(
      `
        SELECT id, url
        FROM feeds
        WHERE normalized_url_hash = $1
        LIMIT 1
      `,
      [normalizedHash],
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      throw new Error('opml_feed_lookup_after_conflict_failed');
    }

    if (normalizeFeedUrl(existing.url) !== normalizedUrl) {
      return { feedId: existing.id, created: false, collision: true };
    }

    return { feedId: existing.id, created: false, collision: false };
  }
}
