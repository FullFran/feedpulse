import { Logger, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import 'reflect-metadata';
import {
  ValidateFeedUrlUseCase,
  mapFetchError,
  type ValidateFeedUrlResult,
} from '../src/modules/feeds/application/validate-feed-url.use-case';
import { ValidateFeedUrlDto, ValidateFeedUrlResultModel } from '../src/modules/feeds/dto/validate-feed-url.dto';
import { FeedsController } from '../src/modules/feeds/http/feeds.controller';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { expectDefined } from './support/expect-defined';

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const TENANT_ID = 'tenant_test';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example City Newsroom</title>
    <link>https://example.com</link>
    <item>
      <title>Council approves the new housing plan</title>
      <link>https://example.com/articles/housing-plan</link>
      <pubDate>Wed, 29 Jul 2026 09:12:00 GMT</pubDate>
    </item>
    <item>
      <title>Budget hearing moved to September</title>
      <link>https://example.com/articles/budget-hearing</link>
      <pubDate>Tue, 28 Jul 2026 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Library reopens after refurbishment</title>
      <link>https://example.com/articles/library</link>
      <pubDate>Mon, 27 Jul 2026 07:30:00 GMT</pubDate>
    </item>
    <item>
      <title>A fourth item that must not be sampled</title>
      <link>https://example.com/articles/fourth</link>
      <pubDate>Sun, 26 Jul 2026 06:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const HTML_FIXTURE = `<!doctype html>
<html><head><title>Not a feed</title></head><body><h1>Subscribe</h1></body></html>`;

describe('ValidateFeedUrlUseCase', () => {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env['ALLOW_PRIVATE_FEED_HOSTS'];

  function stubFetch(handler: FetchHandler): jest.Mock {
    const mock = jest.fn(async (url: string, init?: RequestInit) => handler(url, init));
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  function buildUseCase(configOverrides: Record<string, unknown> = {}): ValidateFeedUrlUseCase {
    const appConfigService = {
      nodeEnv: 'test',
      fetchTimeoutMs: 5_000,
      feedFetchMaxBytes: 5 * 1024 * 1024,
      allowPrivateFeedHosts: false,
      ...configOverrides,
    } as unknown as AppConfigService;

    return new ValidateFeedUrlUseCase(appConfigService);
  }

  function run(url: string, configOverrides: Record<string, unknown> = {}): Promise<ValidateFeedUrlResult> {
    return buildUseCase(configOverrides).execute({ tenantId: TENANT_ID, url });
  }

  beforeEach(() => {
    // The use case logs every blocked or failed probe; keep the suite output clean
    // while still letting assertions inspect what was logged.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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

  describe('a reachable, parseable feed', () => {
    it('returns the title, the full item count and exactly three samples', async () => {
      stubFetch(() => new Response(RSS_FIXTURE, { status: 200, headers: { 'content-type': 'application/rss+xml' } }));

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBeNull();
      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.feedTitle).toBe('Example City Newsroom');
      expect(result.itemCount).toBe(4);
      expect(result.sampleItems).toEqual([
        {
          title: 'Council approves the new housing plan',
          link: 'https://example.com/articles/housing-plan',
          publishedAt: '2026-07-29T09:12:00.000Z',
        },
        {
          title: 'Budget hearing moved to September',
          link: 'https://example.com/articles/budget-hearing',
          publishedAt: '2026-07-28T08:00:00.000Z',
        },
        {
          title: 'Library reopens after refurbishment',
          link: 'https://example.com/articles/library',
          publishedAt: '2026-07-27T07:30:00.000Z',
        },
      ]);
      expect(result.latestItemPublishedAt).toBe('2026-07-29T09:12:00.000Z');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('sends the standard feed headers and follows redirects through the SSRF guard', async () => {
      const mock = stubFetch((url) => {
        if (url === 'https://example.com/feed') {
          return new Response('moved', { status: 301, headers: { location: 'https://cdn.example.com/rss.xml' } });
        }
        return new Response(RSS_FIXTURE, { status: 200 });
      });

      const result = await run('https://example.com/feed');

      expect(result.error).toBeNull();
      const requested = mock.mock.calls.map((call) => (call as [string, RequestInit | undefined])[0]);
      expect(requested).toEqual(['https://example.com/feed', 'https://cdn.example.com/rss.xml']);

      const init = (mock.mock.calls[0] as [string, RequestInit | undefined])[1];
      const headers = init?.headers as Record<string, string>;
      expect(headers['user-agent']).toContain('RSSMonitor/1.0');
      expect(headers['accept']).toContain('application/rss+xml');
      // Redirects are followed manually so every hop is re-validated.
      expect(init?.redirect).toBe('manual');
    });

    it('reports an empty feed as valid with zero items', async () => {
      stubFetch(
        () => new Response('<rss version="2.0"><channel><title>Quiet</title></channel></rss>', { status: 200 }),
      );

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBeNull();
      expect(result.itemCount).toBe(0);
      expect(result.sampleItems).toEqual([]);
      expect(result.latestItemPublishedAt).toBeNull();
    });
  });

  describe('upstream failures', () => {
    it('returns http_404 and never echoes the upstream body', async () => {
      stubFetch(() => new Response('<h1>Not Found</h1> /var/www/site/public', { status: 404 }));

      const result = await run('https://example.com/missing.xml');

      expect(result.error).toBe('http_404');
      expect(result.statusCode).toBe(404);
      expect(result.reachable).toBe(false);
      expect(result.feedTitle).toBeNull();
      expect(result.itemCount).toBeNull();
      expect(result.sampleItems).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('/var/www');
      expect(JSON.stringify(result)).not.toContain('Not Found');
    });

    it('returns http_500 for a server error', async () => {
      stubFetch(() => new Response('boom', { status: 500 }));

      await expect(run('https://example.com/rss.xml')).resolves.toMatchObject({
        error: 'http_500',
        statusCode: 500,
        reachable: false,
      });
    });

    it('returns dns_failure without any resolver detail', async () => {
      stubFetch(() => {
        const error = new Error('fetch failed');
        (error as { cause?: unknown }).cause = {
          code: 'ENOTFOUND',
          hostname: 'nope.invalid',
          syscall: 'getaddrinfo',
        };
        throw error;
      });

      const result = await run('https://nope.invalid/rss.xml');

      expect(result.error).toBe('dns_failure');
      expect(result.statusCode).toBeNull();
      expect(result.reachable).toBe(false);
      expect(JSON.stringify(result)).not.toContain('getaddrinfo');
      expect(JSON.stringify(result)).not.toContain('ENOTFOUND');
    });

    it('returns connection_refused', async () => {
      stubFetch(() => {
        const error = new Error('fetch failed');
        (error as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
        throw error;
      });

      await expect(run('https://example.com/rss.xml')).resolves.toMatchObject({ error: 'connection_refused' });
    });

    it('returns tls_error without certificate internals', async () => {
      stubFetch(() => {
        const error = new Error('fetch failed');
        (error as { cause?: unknown }).cause = { code: 'CERT_HAS_EXPIRED' };
        throw error;
      });

      const result = await run('https://expired.example.com/rss.xml');

      expect(result.error).toBe('tls_error');
      expect(JSON.stringify(result)).not.toContain('CERT_HAS_EXPIRED');
    });

    it('returns timeout when the request is aborted by the deadline', async () => {
      stubFetch(async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('This operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
        return new Response('unreachable', { status: 200 });
      });

      // A 1s clamp floor keeps the suite fast while still exercising the real
      // AbortController wiring rather than a hand-thrown AbortError.
      const result = await run('https://slow.example.com/rss.xml', { fetchTimeoutMs: 10 });

      expect(result.error).toBe('timeout');
      expect(result.statusCode).toBeNull();
    }, 10_000);

    it('returns response_too_large when the body exceeds the byte cap', async () => {
      stubFetch(() => new Response('x'.repeat(4096), { status: 200 }));

      await expect(run('https://example.com/rss.xml', { feedFetchMaxBytes: 128 })).resolves.toMatchObject({
        error: 'response_too_large',
      });
    });

    it('returns too_many_redirects instead of looping', async () => {
      let hop = 0;
      stubFetch(() => {
        hop += 1;
        return new Response('moved', { status: 302, headers: { location: `https://example.com/hop-${hop}` } });
      });

      await expect(run('https://example.com/rss.xml')).resolves.toMatchObject({ error: 'too_many_redirects' });
    });

    it('returns unknown for an unrecognised transport failure', async () => {
      stubFetch(() => {
        throw new Error('something went sideways in /srv/app/node_modules/undici');
      });

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('/srv/app');
    });
  });

  describe('parse failures', () => {
    it('returns parse_error for an HTML page instead of throwing', async () => {
      stubFetch(() => new Response(HTML_FIXTURE, { status: 200, headers: { 'content-type': 'text/html' } }));

      const result = await run('https://example.com/');

      expect(result.error).toBe('parse_error');
      // The origin answered, so the host is reachable; it just is not a feed.
      expect(result.reachable).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.feedTitle).toBeNull();
      expect(result.itemCount).toBeNull();
      expect(result.sampleItems).toEqual([]);
    });

    it('returns parse_error for truncated XML without leaking the parser message', async () => {
      stubFetch(() => new Response('<rss><channel><title>Broken', { status: 200 }));

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBe('parse_error');
      expect(JSON.stringify(result)).not.toContain('Unexpected close tag');
    });
  });

  describe('SSRF containment', () => {
    it.each([
      ['http://127.0.0.1/rss.xml', 'unsafe_host'],
      ['http://169.254.169.254/latest/meta-data/', 'unsafe_host'],
      ['http://10.0.0.5/internal.xml', 'unsafe_host'],
      ['http://192.168.1.10/rss.xml', 'unsafe_host'],
      ['http://[::1]/rss.xml', 'unsafe_host'],
      ['http://metadata/computeMetadata/v1/', 'unsafe_host'],
      ['file:///etc/passwd', 'unsafe_protocol'],
      ['gopher://example.com/rss', 'unsafe_protocol'],
    ])('refuses %s without issuing a request', async (url, expected) => {
      const mock = stubFetch(() => new Response(RSS_FIXTURE, { status: 200 }));

      const result = await run(url);

      expect(result.error).toBe(expected);
      expect(result.reachable).toBe(false);
      expect(result.statusCode).toBeNull();
      // No request at all, and no timing signal that could be used to probe.
      expect(mock).not.toHaveBeenCalled();
      expect(result.latencyMs).toBe(0);
    });

    it('refuses a redirect that lands in a private range', async () => {
      const mock = stubFetch((url) => {
        if (url === 'https://example.com/rss.xml') {
          return new Response('moved', { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
        }
        return new Response('SECRET', { status: 200 });
      });

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBe('unsafe_host');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('honours the self-hosted escape hatch for private feed hosts', async () => {
      stubFetch(() => new Response(RSS_FIXTURE, { status: 200 }));

      const result = await run('http://127.0.0.1:4010/rss.xml', { allowPrivateFeedHosts: true });

      expect(result.error).toBeNull();
      expect(result.feedTitle).toBe('Example City Newsroom');
    });

    it('logs the host but never the credentials, path or query of a blocked probe', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      stubFetch(() => new Response(RSS_FIXTURE, { status: 200 }));

      await run('http://admin:hunter2@127.0.0.1/admin?token=s3cret');

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('reason=unsafe_host');
      expect(logged).not.toContain('hunter2');
      expect(logged).not.toContain('s3cret');
      expect(logged).not.toContain('/admin');
    });
  });

  describe('hostile feed content', () => {
    it('drops non-http item links rather than handing them to a UI', async () => {
      stubFetch(
        () =>
          new Response(
            `<rss version="2.0"><channel><title>Hostile</title>
               <item><title>XSS</title><link>javascript:alert(1)</link></item>
               <item><title>Data</title><link>data:text/html,&lt;script&gt;</link></item>
               <item><title>Fine</title><link>https://example.com/ok</link></item>
             </channel></rss>`,
            { status: 200 },
          ),
      );

      const result = await run('https://example.com/rss.xml');

      expect(result.error).toBeNull();
      expect(result.sampleItems.map((item) => item.link)).toEqual([null, null, 'https://example.com/ok']);
    });

    it('truncates an oversized feed title and item title', async () => {
      const long = 'A'.repeat(5_000);
      stubFetch(
        () =>
          new Response(
            `<rss version="2.0"><channel><title>${long}</title>` +
              `<item><title>${long}</title><link>https://example.com/a</link></item></channel></rss>`,
            { status: 200 },
          ),
      );

      const result = await run('https://example.com/rss.xml');

      expect(result.feedTitle).toHaveLength(301);
      expect(expectDefined(result.sampleItems[0]).title).toHaveLength(301);
    });

    it('normalises unparseable publication dates to null', async () => {
      stubFetch(
        () =>
          new Response(
            `<rss version="2.0"><channel><title>Dates</title>
               <item><title>No date</title><link>https://example.com/a</link><pubDate>whenever</pubDate></item>
             </channel></rss>`,
            { status: 200 },
          ),
      );

      const result = await run('https://example.com/rss.xml');

      expect(expectDefined(result.sampleItems[0]).publishedAt).toBeNull();
      expect(result.latestItemPublishedAt).toBeNull();
    });
  });

  describe('mapFetchError', () => {
    it('maps a non-Error throw to unknown', () => {
      expect(mapFetchError('boom')).toBe('unknown');
      expect(mapFetchError(undefined)).toBe('unknown');
    });

    it('maps undici connect timeouts to timeout', () => {
      const error = new Error('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
      expect(mapFetchError(error)).toBe('timeout');
    });

    it('maps a DNS EAI_AGAIN to dns_failure', () => {
      const error = new Error('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'EAI_AGAIN' };
      expect(mapFetchError(error)).toBe('dns_failure');
    });
  });
});

describe('ValidateFeedUrlDto', () => {
  // `class-validator` metadata is what the global ValidationPipe consumes; the
  // decorators are asserted through it rather than by re-reading the source.
  it('rejects a URL without a scheme, a non-http scheme and an oversized URL', async () => {
    async function codesFor(url: unknown): Promise<string[]> {
      const dto = plainToInstance(ValidateFeedUrlDto, { url });
      const errors = await validate(dto);
      return errors.flatMap((error) => Object.values(error.constraints ?? {}));
    }

    await expect(codesFor('example.com/rss.xml')).resolves.toContain('feed_invalid_url');
    await expect(codesFor('file:///etc/passwd')).resolves.toContain('feed_invalid_url');
    await expect(codesFor(`https://example.com/${'a'.repeat(3000)}`)).resolves.toContain('feed_invalid_url');
    await expect(codesFor(42)).resolves.toContain('feed_invalid_url');
    await expect(codesFor('https://example.com/rss.xml')).resolves.toEqual([]);
  });
});

describe('POST /api/v1/feeds/validate documentation', () => {
  // Asserted through the reflected decorator metadata rather than by booting Nest,
  // so this stays a unit test while still failing if the route or the documented
  // response model is dropped.
  const handler = FeedsController.prototype.validate;

  it('is mounted as POST on the literal `validate` segment before the `:id` routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('validate');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);

    const routeOrder = Object.getOwnPropertyNames(FeedsController.prototype);
    expect(routeOrder.indexOf('validate')).toBeLessThan(routeOrder.indexOf('getById'));
  });

  it('documents the 200 response with the validation result model', () => {
    const responses = Reflect.getMetadata('swagger/apiResponse', handler) as Record<string, unknown> | undefined;
    expect(responses).toBeDefined();
    expect(JSON.stringify(responses?.['200'])).toContain('ValidateFeedUrlResultModel');

    const documented = Reflect.getMetadata(
      'swagger/apiModelPropertiesArray',
      ValidateFeedUrlResultModel.prototype,
    ) as string[];
    expect(documented.map((name) => name.replace(/^:/, '')).sort()).toEqual([
      'error',
      'feedTitle',
      'itemCount',
      'latencyMs',
      'latestItemPublishedAt',
      'reachable',
      'sampleItems',
      'statusCode',
    ]);
  });
});
