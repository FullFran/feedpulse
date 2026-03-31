import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../../../infrastructure/persistence/database.service';
import { OpmlParsePreviewJobData } from '../../../infrastructure/queue/queue.constants';
import { AppConfigService } from '../../../shared/config/app-config.service';

import { assertValidOpmlImportStatusTransition } from '../domain/opml-import-status';
import { extractOpmlItems } from '../domain/opml-parser';
import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../domain/url-normalizer';
import { OpmlImportObservabilityService } from './opml-import-observability.service';
import { OpmlImportItemInput, OpmlImportsRepository } from '../opml-imports.repository';

interface ExistingFeedRow {
  id: number;
  url: string;
  normalized_url_hash: string;
}

@Injectable()
export class ProcessOpmlParseJobUseCase {
  private readonly logger = new Logger(ProcessOpmlParseJobUseCase.name);
  private static readonly MAX_OUTLINE_TAGS = 20_000;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly opmlImportsRepository: OpmlImportsRepository,
    private readonly appConfigService: AppConfigService,
    private readonly observabilityService: OpmlImportObservabilityService,
  ) {}

  async execute(job: OpmlParsePreviewJobData): Promise<void> {
    const current = await this.opmlImportsRepository.getImportOrThrow(job.importId);

    if (current.status === 'preview_ready' || current.status === 'completed' || current.status === 'importing') {
      return;
    }

    if (current.status !== 'uploaded' && current.status !== 'parsing') {
      this.logger.warn(`Skipping parse for import ${job.importId} in status ${current.status}`);
      return;
    }

    assertValidOpmlImportStatusTransition(current.status, 'parsing');
    const stopTimer = this.observabilityService.startJobTimer('parse');

    const client = await this.databaseService.getPool().connect();
    try {
      await client.query('BEGIN');

      await this.opmlImportsRepository.markImportStatus(job.importId, { status: 'parsing', errorMessage: null }, client);

      const parsedItems = extractOpmlItems(job.opmlXml, {
        maxBytes: this.appConfigService.opmlUploadMaxBytes,
        maxOutlineTags: ProcessOpmlParseJobUseCase.MAX_OUTLINE_TAGS,
      });
      const seenHashes = new Set<string>();
      const draftItems = parsedItems.map((item) => {
        const local = this.classifyLocalItem(item);
        if (local.itemStatus !== 'new' || !local.normalizedUrlHash) {
          return local;
        }

        if (seenHashes.has(local.normalizedUrlHash)) {
          return {
            ...local,
            itemStatus: 'duplicate' as const,
            validationError: 'duplicate_within_opml',
          };
        }

        seenHashes.add(local.normalizedUrlHash);
        return local;
      });
      const normalizedCandidates = draftItems.filter(
        (item): item is OpmlImportItemInput & { normalizedUrlHash: string; normalizedUrl: string } => Boolean(item.normalizedUrlHash && item.normalizedUrl),
      );
      const existingByHash = await this.findExistingFeedsByHash(
        normalizedCandidates.map((item) => item.normalizedUrlHash),
        normalizedCandidates.map((item) => item.normalizedUrl),
        client,
      );

      const items = draftItems.map((item) => {
        if (item.itemStatus !== 'new' || !item.normalizedUrlHash || !item.normalizedUrl) {
          return item;
        }

        const existing = existingByHash.get(item.normalizedUrlHash);
        if (!existing) {
          return item;
        }

        if (normalizeFeedUrl(existing.url) !== item.normalizedUrl) {
          return {
            ...item,
            itemStatus: 'invalid' as const,
            validationError: 'normalized_hash_collision_detected',
            normalizedUrl: null,
            normalizedUrlHash: null,
          };
        }

        return {
          ...item,
          itemStatus: 'existing' as const,
        };
      });

      const counters = {
        totalItems: items.length,
        validItems: items.filter((item) => item.itemStatus !== 'invalid').length,
        duplicateItems: items.filter((item) => item.itemStatus === 'duplicate').length,
        existingItems: items.filter((item) => item.itemStatus === 'existing').length,
        invalidItems: items.filter((item) => item.itemStatus === 'invalid').length,
      };

      await this.opmlImportsRepository.replaceImportItems(job.importId, items, client);
      await this.opmlImportsRepository.markImportStatus(
        job.importId,
        {
          status: 'preview_ready',
          errorMessage: null,
          counters,
        },
        client,
      );

      await client.query('COMMIT');
      stopTimer('success');
    } catch (error) {
      await client.query('ROLLBACK');
      const message = error instanceof Error ? error.message : 'unknown_opml_parse_failure';

      await this.opmlImportsRepository.markImportStatus(job.importId, {
        status: 'failed_validation',
        errorMessage: message,
      });
      this.logger.error(`OPML parse failed for import ${job.importId}: ${message}`);
      stopTimer('error', 'parse_failed');
    } finally {
      client.release();
    }
  }

  private classifyLocalItem(item: { title: string | null; outlinePath: string | null; sourceXmlUrl: string }): OpmlImportItemInput {
    try {
      const normalizedUrl = normalizeFeedUrl(item.sourceXmlUrl);
      const normalizedUrlHash = buildNormalizedFeedUrlHash(normalizedUrl);

      return {
        title: item.title,
        outlinePath: item.outlinePath,
        sourceXmlUrl: item.sourceXmlUrl,
        normalizedUrl,
        normalizedUrlHash,
        itemStatus: 'new',
        validationError: null,
      };
    } catch (error) {
      return {
        title: item.title,
        outlinePath: item.outlinePath,
        sourceXmlUrl: item.sourceXmlUrl,
        normalizedUrl: null,
        normalizedUrlHash: null,
        itemStatus: 'invalid',
        validationError: error instanceof Error ? error.message : 'feed_url_invalid',
      };
    }
  }

  private async findExistingFeedsByHash(hashes: string[], normalizedUrls: string[], executor: Pick<DatabaseService, 'query'>): Promise<Map<string, ExistingFeedRow>> {
    const uniqueHashes = [...new Set(hashes)];
    const uniqueUrls = [...new Set(normalizedUrls)];

    if (!uniqueHashes.length && !uniqueUrls.length) {
      return new Map();
    }

    const result = await executor.query<ExistingFeedRow>(
      `
        SELECT id, url, normalized_url_hash
        FROM feeds
        WHERE normalized_url_hash = ANY($1::text[])
           OR url = ANY($2::text[])
      `,
      [uniqueHashes, uniqueUrls],
    );

    const map = new Map<string, ExistingFeedRow>();
    for (const row of result.rows) {
      map.set(row.normalized_url_hash, row);
    }

    return map;
  }
}
