import type { DomainRateLimiter } from '../src/modules/ingestion/infrastructure/domain-rate-limiter';
import { HttpFeedFetcher } from '../src/modules/ingestion/infrastructure/http-feed.fetcher';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { UnsafeHostError } from '../src/shared/http/url-safety';
import { expectDefined } from './support/expect-defined';

type FetchCall = [string, RequestInit | undefined];

class FakeRateLimiter {
  readonly events: string[] = [];
  readonly backoffs: Array<{ url: string; retryAfter: string | null; isRetry: boolean }> = [];
  readonly cleared: string[] = [];

  async waitForSlot(url: string): Promise<number> {
    this.events.push(`waitForSlot:${url}`);
    return 0;
  }

  applyBackoff(url: string, retryAfter: string | null, isRetry: boolean): void {
    this.events.push(`applyBackoff:${url}`);
    this.backoffs.push({ url, retryAfter, isRetry });
  }

  clearBackoff(url: string): void {
    this.events.push(`clearBackoff:${url}`);
    this.cleared.push(url);
  }
}

describe('HttpFeedFetcher', () => {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env['ALLOW_PRIVATE_FEED_HOSTS'];
  let rateLimiter: FakeRateLimiter;

  function buildFetcher(configOverrides: Record<string, unknown> = {}): HttpFeedFetcher {
    const appConfigService = { nodeEnv: 'test', ...configOverrides } as unknown as AppConfigService;
    return new HttpFeedFetcher(rateLimiter as unknown as DomainRateLimiter, appConfigService);
  }

  function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): jest.Mock {
    const mock = jest.fn(async (url: string, init?: RequestInit) => handler(url, init));
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  function calls(mock: jest.Mock): FetchCall[] {
    return mock.mock.calls as FetchCall[];
  }

  beforeEach(() => {
    rateLimiter = new FakeRateLimiter();
  });

  afterEach(() => {
    // Restore the global stub or it leaks into every later spec file.
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) {
      delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];
    } else {
      process.env['ALLOW_PRIVATE_FEED_HOSTS'] = originalAllowPrivate;
    }
    jest.restoreAllMocks();
  });

  it('sends conditional headers only when etag and lastModified are provided', async () => {
    const mock = stubFetch(() => new Response('<rss/>', { status: 200 }));

    const fetcher = buildFetcher();
    await fetcher.fetch('https://example.com/rss.xml', { timeoutMs: 1_000 });

    const [, plainInit] = expectDefined(calls(mock)[0]);
    const plainHeaders = plainInit?.headers as Record<string, string>;
    expect(plainHeaders['user-agent']).toContain('RSSMonitor/1.0');
    expect(plainHeaders['if-none-match']).toBeUndefined();
    expect(plainHeaders['if-modified-since']).toBeUndefined();

    mock.mockClear();
    await fetcher.fetch('https://example.com/rss.xml', {
      etag: 'W/"abc"',
      lastModified: 'Fri, 20 Mar 2026 10:00:00 GMT',
      timeoutMs: 1_000,
    });

    const [, conditionalInit] = expectDefined(calls(mock)[0]);
    const conditionalHeaders = conditionalInit?.headers as Record<string, string>;
    expect(conditionalHeaders['if-none-match']).toBe('W/"abc"');
    expect(conditionalHeaders['if-modified-since']).toBe('Fri, 20 Mar 2026 10:00:00 GMT');
  });

  it('waits for a rate limit slot before issuing the request', async () => {
    const observed: string[] = [];
    const mock = stubFetch(() => {
      observed.push(...rateLimiter.events);
      return new Response('<rss/>', { status: 200 });
    });

    await buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 });

    expect(observed).toEqual(['waitForSlot:https://example.com/rss.xml']);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('returns the body, caching headers, final URL and duration', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/rss.xml') {
        return new Response('moved', { status: 301, headers: { location: 'https://cdn.example.com/rss.xml' } });
      }
      return new Response('<rss>ok</rss>', {
        status: 200,
        headers: { etag: 'W/"v2"', 'last-modified': 'Fri, 20 Mar 2026 10:00:00 GMT' },
      });
    });

    const result = await buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('<rss>ok</rss>');
    expect(result.etag).toBe('W/"v2"');
    expect(result.lastModified).toBe('Fri, 20 Mar 2026 10:00:00 GMT');
    expect(result.finalUrl).toBe('https://cdn.example.com/rss.xml');
    expect(result.retryAfterSeconds).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not read a body for a 304 response', async () => {
    stubFetch(() => new Response(null, { status: 304, headers: { etag: 'W/"v1"' } }));

    const result = await buildFetcher().fetch('https://example.com/rss.xml', { etag: 'W/"v1"', timeoutMs: 1_000 });

    expect(result.statusCode).toBe(304);
    expect(result.body).toBe('');
    expect(result.etag).toBe('W/"v1"');
  });

  it('applies backoff and throws on 429', async () => {
    stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));

    await expect(buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 })).rejects.toThrow(
      'Rate limited (429) for https://example.com/rss.xml, retry after 120',
    );

    expect(rateLimiter.events).toEqual([
      'waitForSlot:https://example.com/rss.xml',
      'applyBackoff:https://example.com/rss.xml',
    ]);
    expect(rateLimiter.backoffs).toEqual([{ url: 'https://example.com/rss.xml', retryAfter: '120', isRetry: true }]);
  });

  it('honours Retry-After on 503 as well', async () => {
    stubFetch(() => new Response('unavailable', { status: 503, headers: { 'retry-after': '30' } }));

    await expect(buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 })).rejects.toThrow(
      'Rate limited (503)',
    );

    expect(rateLimiter.backoffs).toEqual([{ url: 'https://example.com/rss.xml', retryAfter: '30', isRetry: false }]);
  });

  it('leaves a 503 without Retry-After to the caller as a normal status code', async () => {
    stubFetch(() => new Response('unavailable', { status: 503 }));

    const result = await buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 });

    expect(result.statusCode).toBe(503);
    expect(rateLimiter.backoffs).toHaveLength(0);
  });

  it('rejects unsafe hosts before consuming a rate limit slot', async () => {
    const mock = stubFetch(() => new Response('<rss/>', { status: 200 }));

    await expect(
      buildFetcher().fetch('http://169.254.169.254/latest/meta-data/', { timeoutMs: 1_000 }),
    ).rejects.toThrow(UnsafeHostError);

    expect(rateLimiter.events).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects a redirect into a private range', async () => {
    stubFetch((url) => {
      if (url === 'https://example.com/rss.xml') {
        return new Response('moved', { status: 302, headers: { location: 'http://10.0.0.5/internal.xml' } });
      }
      return new Response('<rss/>', { status: 200 });
    });

    await expect(buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 })).rejects.toThrow(
      'unsafe_host',
    );
  });

  it('allows private hosts when the configuration enables the escape hatch', async () => {
    stubFetch(() => new Response('<rss/>', { status: 200 }));

    const result = await buildFetcher({ allowPrivateFeedHosts: true }).fetch('http://127.0.0.1:4010/rss.xml', {
      timeoutMs: 1_000,
    });

    expect(result.statusCode).toBe(200);
  });

  it('enforces the configured body cap', async () => {
    stubFetch(() => new Response('x'.repeat(500), { status: 200 }));

    await expect(
      buildFetcher({ feedFetchMaxBytes: 100 }).fetch('https://example.com/rss.xml', { timeoutMs: 1_000 }),
    ).rejects.toThrow('feed_body_too_large');
  });

  it('clears the backoff when the request is aborted', async () => {
    stubFetch(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    });

    await expect(buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 })).rejects.toThrow(
      'The operation was aborted',
    );

    expect(rateLimiter.cleared).toEqual(['https://example.com/rss.xml']);
  });

  it('clears the request timeout on both success and failure', async () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    stubFetch(() => new Response('<rss/>', { status: 200 }));
    await buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 });
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    stubFetch(() => {
      throw new Error('network down');
    });
    await expect(buildFetcher().fetch('https://example.com/rss.xml', { timeoutMs: 1_000 })).rejects.toThrow(
      'network down',
    );
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
