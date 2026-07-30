import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { DatabaseService } from '../../../infrastructure/persistence/database.service';
import { ReadinessService } from '../../../infrastructure/persistence/readiness.service';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { normalizeSearchText } from '../../../shared/text/normalize-search-text';
import { AlertsRepository } from '../../alerts/alerts.repository';
import { DeliverAlertUseCase } from '../../alerts/application/deliver-alert.use-case';
import { EntriesRepository } from '../../entries/entries.repository';
import { FeedsRepository } from '../../feeds/feeds.repository';
import { MetricsService } from '../../observability/metrics.service';
import { RulesRepository } from '../../rules/rules.repository';
import { FEED_FETCHER, FeedFetcherPort } from '../domain/feed-fetcher.port';
import { ruleMatchesNormalizedText } from '../domain/keyword-match';

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

/**
 * Normalize a feed timestamp to a stable UTC ISO-8601 instant.
 *
 * Feeds report `pubDate` in half a dozen formats, and the raw string used to
 * feed the content hash directly. Normalizing first makes the hash reproducible
 * from the stored `published_at` column, which is what lets migration 0017
 * recompute it in SQL. Unparseable timestamps become null rather than being
 * handed to Postgres as garbage.
 */
function normalizePublishedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Coerce whatever `rss-parser` produced for `<guid>` into a usable string.
 *
 * `rss-parser` yields a plain string for a bare element, but an object of the
 * shape `{ _: 'value', $: { isPermaLink: 'false' } }` when the element carries
 * XML attributes — and `<guid isPermaLink="false">` is extremely common. A bare
 * `String(...)` on that object returns the literal `'[object Object]'`, which
 * is truthy, so it would win over the item link and hand every item in the feed
 * the same guid. Unwrapping the text node fixes the common case; anything with
 * no meaningful string form becomes null so the caller falls back to the link.
 */
function normalizeRawGuid(rawGuid: unknown): string | null {
  if (typeof rawGuid === 'string') {
    return rawGuid;
  }

  if (rawGuid === null || rawGuid === undefined) {
    return null;
  }

  if (typeof rawGuid === 'number' || typeof rawGuid === 'bigint' || typeof rawGuid === 'boolean') {
    return String(rawGuid);
  }

  if (typeof rawGuid === 'object' && '_' in rawGuid) {
    const textNode: unknown = rawGuid._;
    return typeof textNode === 'string' ? textNode : null;
  }

  return null;
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

  async execute(job: {
    feedId: number;
  }): Promise<{ insertedEntries: number; createdAlerts: number; statusCode: number }> {
    await this.readinessService.assertSchemaReady();
    // Deliberately cross-tenant: the scheduler hands this worker a bare feed id and the tenant
    // is only known once the row is read. Named `...ForWorker` so `rg 'ForWorker'` enumerates
    // every cross-tenant read in the application. Every subsequent query in this method is
    // scoped by `feed.tenantId`, which is the value that row carries.
    const feed = await this.feedsRepository.findByIdForWorker(job.feedId);

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
        const guidValue = normalizeRawGuid(rawGuid);
        const title = item.title?.trim() ?? null;
        const link = item.link?.trim() ?? null;
        const guid = guidValue?.trim() || link || null;
        const content = item.contentSnippet?.trim() ?? item.content?.trim() ?? null;
        const publishedAt = normalizePublishedAt(item.isoDate ?? item.pubDate ?? null);
        // Identity of an article is link + guid + publication instant. The title
        // is deliberately excluded: publishers revise headlines after
        // publication, and hashing the title turned every revision into a new
        // entry and therefore a duplicate alert for the same article.
        const contentHash = createHash('sha256')
          .update(`${link ?? ''}|${guid ?? ''}|${publishedAt ?? ''}`)
          .digest('hex');

        return { title, link, guid, content, publishedAt, contentHash };
      });

      const client = await this.databaseService.getPool().connect();
      try {
        await client.query('BEGIN');
        const insertedEntries = await this.entriesRepository.insertMany(
          feed.tenantId,
          feed.id,
          normalizedEntries,
          client,
        );
        const activeRules = await this.rulesRepository.listActive(feed.tenantId);

        // Find matching entries and aggregate rules - ONE alert per article (not one per rule)
        const matchesByEntry = new Map<string, number[]>(); // entryId -> ruleIds[]

        for (const entry of insertedEntries) {
          const haystack = normalizeSearchText(`${entry.title ?? ''} ${entry.content ?? ''}`);
          const matchingRuleIds = activeRules
            .filter((rule) => ruleMatchesNormalizedText(haystack, rule))
            .map((rule) => rule.id);

          if (matchingRuleIds.length > 0) {
            matchesByEntry.set(entry.id, matchingRuleIds);
          }
        }

        // Now create alerts with all matching rules for each entry
        const alertOutcome = await this.alertsRepository.createForEntryWithRules(matchesByEntry, client);
        await this.recordFetchLog(
          feed.id,
          feed.tenantId,
          response.statusCode,
          response.durationMs,
          false,
          null,
          client,
        );

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
        this.metricsService.incrementAlertsGenerated(alertOutcome.created.length);

        if (alertOutcome.ruleSetExtended.length > 0) {
          // Surfaced rather than swallowed: these articles were already
          // delivered, so a newly matching rule updates matched_rules without
          // sending the reader the same article twice.
          this.logger.log(
            `Feed ${feed.id}: ${alertOutcome.ruleSetExtended.length} existing alert(s) gained rules without re-delivery ` +
              `(alert ids: ${alertOutcome.ruleSetExtended.map((alert) => alert.id).join(', ')})`,
          );
        }

        await this.deliverAlerts(alertOutcome.created.map((alert) => Number(alert.id)));

        return {
          insertedEntries: insertedEntries.length,
          createdAlerts: alertOutcome.created.length,
          statusCode: response.statusCode,
        };
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

  private classifyFeedFailure(
    message: string,
    errorCount: number,
    pollIntervalSeconds: number,
  ): FeedFailureClassification {
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
    const hardXml =
      normalized.includes('unable to parse xml') ||
      normalized.includes('invalid character in') ||
      normalized.includes('attribute without value');
    // The SSRF guard rejects a feed whose URL — or any redirect hop of it — resolves
    // into loopback/RFC1918/link-local space, or whose scheme is not http(s). That
    // never becomes valid on its own, and an oversized body is not transient either,
    // so both auto-pause instead of retrying forever.
    const unsafeTarget =
      normalized.includes('unsafe_host') ||
      normalized.includes('unsafe_protocol') ||
      normalized.includes('feed_url_host_not_allowed');
    const oversizedBody = normalized.includes('feed_body_too_large');
    const repeatedlyForbidden = normalized.includes('status 403') && errorCount >= 5;
    const dnsResolutionFailure = this.isDnsResolutionFailure(normalized) && errorCount >= 3;

    if (http404 || http410) {
      return 'terminal_not_found';
    }

    if (unsupported || unsafeTarget || oversizedBody) {
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
