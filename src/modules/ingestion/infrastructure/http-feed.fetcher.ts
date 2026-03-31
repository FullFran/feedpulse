import { Injectable } from '@nestjs/common';

import { FeedFetcherPort, FeedFetchResult } from '../domain/feed-fetcher.port';
import { HttpAgents } from './http-agents';
import { DomainRateLimiter } from './domain-rate-limiter';

@Injectable()
export class HttpFeedFetcher implements FeedFetcherPort {
  constructor(
    private readonly agents: HttpAgents,
    private readonly rateLimiter: DomainRateLimiter,
  ) {}

  async fetch(
    url: string,
    options: { etag?: string | null; lastModified?: string | null; timeoutMs: number },
  ): Promise<FeedFetchResult> {
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
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      const statusCode = response.status;

      // Handle rate limiting with Retry-After
      if (statusCode === 429) {
        const retryAfter = DomainRateLimiter.parseRetryAfter(response.headers.get('retry-after'));
        this.rateLimiter.applyBackoff(url, retryAfter, true);
        throw new Error(`Rate limited (429) for ${url}, retry after ${retryAfter ?? 'exponential backoff'}`);
      }

      return {
        statusCode,
        body: await response.text(),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        durationMs: Date.now() - startedAt,
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
