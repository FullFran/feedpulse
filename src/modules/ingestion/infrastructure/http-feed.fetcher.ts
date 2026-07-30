import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { readBodyWithLimit, resolveFeedFetchMaxBytes, safeFetch } from '../../../shared/http/safe-fetch';
import { assertSafePublicUrl, resolveAllowPrivateFeedHosts } from '../../../shared/http/url-safety';
import { FeedFetcherPort, FeedFetchResult } from '../domain/feed-fetcher.port';
import { DomainRateLimiter } from './domain-rate-limiter';

/** Statuses whose `Retry-After` header we honour by backing the domain off. */
const THROTTLED_STATUS_CODES = new Set([429, 503]);

@Injectable()
export class HttpFeedFetcher implements FeedFetcherPort {
  constructor(
    private readonly rateLimiter: DomainRateLimiter,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
  ) {}

  async fetch(
    url: string,
    options: { etag?: string | null; lastModified?: string | null; timeoutMs: number },
  ): Promise<FeedFetchResult> {
    const allowPrivateHosts = resolveAllowPrivateFeedHosts(this.appConfigService);

    // Validate BEFORE consuming a rate-limit slot: a blocked URL must not be
    // able to stall the worker on another domain's backoff.
    assertSafePublicUrl(url, { allowPrivateHosts });

    // Wait for rate limit slot before making request
    await this.rateLimiter.waitForSlot(url);

    const headers: Record<string, string> = {
      'user-agent': 'RSSMonitor/1.0 (+https://github.com/hagalink/rss-monitor)',
      accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
    };
    if (options.etag) {
      headers['if-none-match'] = options.etag;
    }
    if (options.lastModified) {
      headers['if-modified-since'] = options.lastModified;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = Date.now();

    try {
      const { response, finalUrl } = await safeFetch(
        url,
        {
          headers,
          signal: controller.signal,
        },
        { allowPrivateHosts },
      );

      const statusCode = response.status;
      const retryAfterHeader = DomainRateLimiter.parseRetryAfter(response.headers.get('retry-after'));
      const retryAfterSeconds = toRetryAfterSeconds(retryAfterHeader);

      // Handle rate limiting with Retry-After (429 always, 503 when the origin
      // told us when to come back).
      if (statusCode === 429 || (THROTTLED_STATUS_CODES.has(statusCode) && retryAfterHeader !== null)) {
        this.rateLimiter.applyBackoff(url, retryAfterHeader, statusCode === 429);
        throw new Error(
          `Rate limited (${statusCode}) for ${url}, retry after ${retryAfterHeader ?? 'exponential backoff'}`,
        );
      }

      const maxBytes = resolveFeedFetchMaxBytes(this.appConfigService);

      return {
        statusCode,
        body: statusCode === 304 ? '' : await readBodyWithLimit(response, maxBytes),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        durationMs: Date.now() - startedAt,
        finalUrl,
        retryAfterSeconds,
      };
    } catch (error) {
      // On network errors, clear any backoff since the server may be temporarily unavailable
      if (error instanceof Error && error.name === 'AbortError') {
        this.rateLimiter.clearBackoff(url);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * `DomainRateLimiter.parseRetryAfter` returns the raw header (seconds string or
 * HTTP-date). The port exposes it as seconds so callers do not re-parse it.
 */
function toRetryAfterSeconds(retryAfterHeader: string | null): number | null {
  if (retryAfterHeader === null) {
    return null;
  }

  const seconds = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds);
  }

  const retryAt = new Date(retryAfterHeader).getTime();
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
