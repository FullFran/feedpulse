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

const AUTO_PAUSED_ERROR_PREFIX = 'auto-paused:';
const DNS_AUTO_PAUSE_DELAY_SECONDS = 12 * 60 * 60;
const BLOCKED_AUTO_PAUSE_DELAY_SECONDS = 14 * 60 * 60;

type FeedFailureCategory =
  | 'terminal_not_found'
  | 'terminal_invalid_feed'
  | 'terminal_invalid_xml'
  | 'auto_paused_dns'
  | 'auto_paused_blocked'
  | 'transient';

interface FeedFailureClassification {
  category: FeedFailureCategory;
  status: 'paused' | 'error';
  nextCheckInSeconds: number;
  lastError: string;
  shouldRethrow: boolean;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsNormalizedPhrase(haystack: string, phrase: string): boolean {
  const normalizedPhrase = normalizeSearchText(phrase);

  if (!normalizedPhrase) {
    return false;
  }

  return haystack.includes(normalizedPhrase);
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
        const rawGuid = (item as { guid?: unknown }).guid;
        const guidValue = typeof rawGuid === 'string' ? rawGuid : rawGuid == null ? null : String(rawGuid);
        const title = item.title?.trim() ?? null;
        const link = item.link?.trim() ?? null;
        const guid = guidValue?.trim() || link || null;
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
              const includes = rule.includeKeywords.every((keyword) => containsNormalizedPhrase(haystack, keyword));
              const excludes = rule.excludeKeywords.some((keyword) => containsNormalizedPhrase(haystack, keyword));
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
      const nextErrorCount = feed.errorCount + 1;
      const classification = this.classifyFeedFailure(message, nextErrorCount, feed.pollIntervalSeconds);
      await this.recordFetchLog(feed.id, feed.tenantId, null, null, true, message);
      await this.feedsRepository.updateAfterFetch({
        feedId: feed.id,
        status: classification.status,
        errorCount: nextErrorCount,
        lastError: classification.lastError,
        nextCheckAt: new Date(Date.now() + classification.nextCheckInSeconds * 1000).toISOString(),
      });

      if (!classification.shouldRethrow) {
        this.logger.warn(`Feed ${feed.id} moved to ${classification.status} (${classification.category}): ${message}`);
        return { insertedEntries: 0, createdAlerts: 0, statusCode: 0 };
      }

      throw error;
    }
  }

  private computeErrorBackoffSeconds(pollIntervalSeconds: number, errorCount: number): number {
    const cappedErrors = Math.max(1, Math.min(errorCount, 6));
    const exponential = pollIntervalSeconds * 2 ** (cappedErrors - 1);
    const capped = Math.min(exponential, 6 * 60 * 60); // 6h max backoff
    const jitter = Math.floor(Math.random() * Math.min(15 * 60, Math.max(1, Math.floor(capped * 0.15))));
    return capped + jitter;
  }

  private computeAutoPauseBackoffSeconds(baseDelaySeconds: number): number {
    const jitter = Math.floor(Math.random() * 30 * 60);
    return baseDelaySeconds + jitter;
  }

  private classifyFeedFailure(message: string, errorCount: number, pollIntervalSeconds: number): FeedFailureClassification {
    const category = this.detectFeedFailureCategory(message, errorCount);

    if (category === 'auto_paused_dns') {
      return {
        category,
        status: 'paused',
        nextCheckInSeconds: this.computeAutoPauseBackoffSeconds(DNS_AUTO_PAUSE_DELAY_SECONDS),
        lastError: `${AUTO_PAUSED_ERROR_PREFIX} ${message}`,
        shouldRethrow: false,
      };
    }

    if (category === 'auto_paused_blocked') {
      return {
        category,
        status: 'paused',
        nextCheckInSeconds: this.computeAutoPauseBackoffSeconds(BLOCKED_AUTO_PAUSE_DELAY_SECONDS),
        lastError: `${AUTO_PAUSED_ERROR_PREFIX} ${message}`,
        shouldRethrow: false,
      };
    }

    if (category !== 'transient') {
      return {
        category,
        status: 'paused',
        nextCheckInSeconds: this.computeErrorBackoffSeconds(pollIntervalSeconds, errorCount),
        lastError: message,
        shouldRethrow: false,
      };
    }

    return {
      category,
      status: 'error',
      nextCheckInSeconds: this.computeErrorBackoffSeconds(pollIntervalSeconds, errorCount),
      lastError: message,
      shouldRethrow: true,
    };
  }

  private detectFeedFailureCategory(message: string, errorCount: number): FeedFailureCategory {
    const normalized = message.toLowerCase();
    const http404 = normalized.includes('status 404');
    const http410 = normalized.includes('status 410');
    const unsupported = normalized.includes('feed not recognized as rss');
    const hardXml = normalized.includes('unable to parse xml') || normalized.includes('invalid character in') || normalized.includes('attribute without value');
    const repeatedlyForbidden = normalized.includes('status 403') && errorCount >= 5;
    const dnsResolutionFailure = this.isDnsResolutionFailure(normalized) && errorCount >= 3;

    if (http404 || http410) {
      return 'terminal_not_found';
    }

    if (unsupported) {
      return 'terminal_invalid_feed';
    }

    if (hardXml) {
      return 'terminal_invalid_xml';
    }

    if (repeatedlyForbidden) {
      return 'auto_paused_blocked';
    }

    if (dnsResolutionFailure) {
      return 'auto_paused_dns';
    }

    return 'transient';
  }

  private isDnsResolutionFailure(normalizedMessage: string): boolean {
    return (
      normalizedMessage.includes('could not resolve host') ||
      normalizedMessage.includes('enotfound') ||
      normalizedMessage.includes('eai_again')
    );
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
