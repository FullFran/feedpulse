import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Parser from 'rss-parser';

import { DatabaseService } from '../../../infrastructure/persistence/database.service';
import { ReadinessService } from '../../../infrastructure/persistence/readiness.service';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { MetricsService } from '../../observability/metrics.service';
import { DeliverAlertUseCase } from '../../alerts/application/deliver-alert.use-case';
import { AlertsRepository } from '../../alerts/alerts.repository';
import { EntriesRepository } from '../../entries/entries.repository';
import { FeedsRepository } from '../../feeds/feeds.repository';
import { RulesRepository } from '../../rules/rules.repository';
import { FEED_FETCHER, FeedFetcherPort } from '../domain/feed-fetcher.port';

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

@Injectable()
export class ProcessFeedJobUseCase {
  private readonly parser = new Parser();
  private readonly logger = new Logger(ProcessFeedJobUseCase.name);

  constructor(
    private readonly readinessService: ReadinessService,
    private readonly databaseService: DatabaseService,
    private readonly feedsRepository: FeedsRepository,
    private readonly entriesRepository: EntriesRepository,
    private readonly rulesRepository: RulesRepository,
    private readonly alertsRepository: AlertsRepository,
    private readonly deliverAlertUseCase: DeliverAlertUseCase,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
    private readonly metricsService: MetricsService,
    @Inject(FEED_FETCHER) private readonly feedFetcher: FeedFetcherPort,
  ) {}

  async execute(job: { feedId: number }): Promise<{ insertedEntries: number; createdAlerts: number; statusCode: number }> {
    await this.readinessService.assertSchemaReady();
    const feed = await this.feedsRepository.findById(job.feedId);

    if (!feed) {
      throw new NotFoundException('feed_not_found');
    }

    try {
      const response = await this.feedFetcher.fetch(feed.url, {
        etag: feed.etag,
        lastModified: feed.lastModified,
        timeoutMs: this.appConfigService.fetchTimeoutMs,
      });

      this.metricsService.observeFetchDuration(response.durationMs);

      if (response.statusCode === 304) {
        await this.recordFetchLog(feed.id, feed.tenantId, response.statusCode, response.durationMs, false, null);
        await this.feedsRepository.updateAfterFetch({
          feedId: feed.id,
          etag: response.etag,
          lastModified: response.lastModified,
          status: 'active',
          errorCount: 0,
          lastError: null,
          avgResponseMs: response.durationMs,
          nextCheckAt: new Date(Date.now() + feed.pollIntervalSeconds * 1000).toISOString(),
        });

        return { insertedEntries: 0, createdAlerts: 0, statusCode: response.statusCode };
      }

      if (response.statusCode >= 400) {
        throw new Error(`Feed fetch failed with status ${response.statusCode}`);
      }

      const parsed = await this.parser.parseString(response.body);
      const normalizedEntries = parsed.items.map((item) => {
        const title = item.title?.trim() ?? null;
        const link = item.link?.trim() ?? null;
        const guid = item.guid?.trim() || link || null;
        const content = item.contentSnippet?.trim() ?? item.content?.trim() ?? null;
        const publishedAt = item.isoDate ?? item.pubDate ?? null;
        const contentHash = createHash('sha256')
          .update(`${title ?? ''}|${link ?? ''}|${publishedAt ?? ''}`)
          .digest('hex');

        return { title, link, guid, content, publishedAt, contentHash };
      });

      const client = await this.databaseService.getPool().connect();
      try {
        await client.query('BEGIN');
        const insertedEntries = await this.entriesRepository.insertMany(feed.tenantId, feed.id, normalizedEntries, client);
        const activeRules = await this.rulesRepository.listActive(feed.tenantId);
        const matches = insertedEntries.flatMap((entry) => {
          const haystack = normalizeSearchText(`${entry.title ?? ''} ${entry.content ?? ''}`);

          return activeRules
            .filter((rule) => {
              const includes = rule.includeKeywords.every((keyword) => haystack.includes(normalizeSearchText(keyword)));
              const excludes = rule.excludeKeywords.some((keyword) => haystack.includes(normalizeSearchText(keyword)));
              return includes && !excludes;
            })
            .map((rule) => ({ entryId: entry.id, ruleId: rule.id }));
        });

        const createdAlerts = await this.alertsRepository.createForMatches(matches, client);
        await this.recordFetchLog(feed.id, feed.tenantId, response.statusCode, response.durationMs, false, null, client);

        await this.feedsRepository.updateAfterFetch({
          feedId: feed.id,
          etag: response.etag,
          lastModified: response.lastModified,
          status: 'active',
          errorCount: 0,
          lastError: null,
          avgResponseMs: response.durationMs,
          nextCheckAt: new Date(Date.now() + feed.pollIntervalSeconds * 1000).toISOString(),
          executor: client,
        });

        await client.query('COMMIT');

        this.metricsService.incrementEntriesInserted(insertedEntries.length);
        this.metricsService.incrementAlertsGenerated(createdAlerts.length);
        await this.deliverAlerts(createdAlerts.map((alert) => Number(alert.id)));

        return { insertedEntries: insertedEntries.length, createdAlerts: createdAlerts.length, statusCode: response.statusCode };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown fetch failure';
      this.metricsService.incrementFetchErrors();
      await this.recordFetchLog(feed.id, feed.tenantId, null, null, true, message);
      await this.feedsRepository.updateAfterFetch({
        feedId: feed.id,
        status: 'error',
        errorCount: feed.errorCount + 1,
        lastError: message,
        nextCheckAt: new Date(Date.now() + feed.pollIntervalSeconds * 1000).toISOString(),
      });
      throw error;
    }
  }

  private async deliverAlerts(alertIds: number[]): Promise<void> {
    for (const alertId of alertIds) {
      try {
          await this.deliverAlertUseCase.execute(alertId, 'ingestion');
        } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown alert delivery failure';
        this.logger.warn(`Alert ${alertId} delivery skipped: ${message}`);
      }
    }
  }

  private async recordFetchLog(
    feedId: number,
    tenantId: string,
    statusCode: number | null,
    responseTimeMs: number | null,
    error: boolean,
    errorMessage: string | null,
      client?: Pick<DatabaseService, 'query'>,
  ): Promise<void> {
    const executor = client ?? this.databaseService;
    await executor.query(
      `
        INSERT INTO fetch_logs (feed_id, tenant_id, status_code, response_time_ms, error, error_message)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [feedId, tenantId, statusCode, responseTimeMs, error, errorMessage],
    );
  }
}
