import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../src/modules/opml-imports/domain/url-normalizer';

describe('normalizeFeedUrl', () => {
  it('normalizes host/protocol casing and removes default port', () => {
    const a = normalizeFeedUrl('HTTP://Example.COM:80/rss.xml');
    const b = normalizeFeedUrl('http://example.com/rss.xml');

    expect(a).toBe('http://example.com/rss.xml');
    expect(a).toBe(b);
  });

  it('normalizes repeated slashes and trailing slash', () => {
    const a = normalizeFeedUrl('https://example.com//feeds///');
    const b = normalizeFeedUrl('https://example.com/feeds');

    expect(a).toBe('https://example.com/feeds');
    expect(a).toBe(b);
  });

  it('drops hash fragments and keeps query string as-is', () => {
    const normalized = normalizeFeedUrl('https://example.com/rss.xml?lang=es#section-1');
    expect(normalized).toBe('https://example.com/rss.xml?lang=es');
  });

  it('rejects non-http(s) URLs', () => {
    expect(() => normalizeFeedUrl('ftp://example.com/feed.xml')).toThrow('feed_url_protocol_not_supported');
  });

  it('rejects empty and unparseable input', () => {
    expect(() => normalizeFeedUrl('   ')).toThrow('feed_url_empty');
    expect(() => normalizeFeedUrl('not a url')).toThrow('feed_url_invalid');
  });

  it('rejects loopback, private, link-local and internal-only hosts', () => {
    expect(() => normalizeFeedUrl('http://localhost:4010/feed.xml')).toThrow('feed_url_host_not_allowed');
    expect(() => normalizeFeedUrl('http://127.0.0.1/feed.xml')).toThrow('feed_url_host_not_allowed');
    expect(() => normalizeFeedUrl('http://10.0.0.7/feed.xml')).toThrow('feed_url_host_not_allowed');
    expect(() => normalizeFeedUrl('http://169.254.169.254/latest/meta-data/')).toThrow('feed_url_host_not_allowed');
    expect(() => normalizeFeedUrl('http://[::1]/feed.xml')).toThrow('feed_url_host_not_allowed');
    expect(() => normalizeFeedUrl('http://intranet/feed.xml')).toThrow('feed_url_host_not_allowed');
  });

  it('accepts private hosts when the escape hatch is enabled', () => {
    expect(normalizeFeedUrl('http://127.0.0.1:4010/feed.xml', { allowPrivateHosts: true })).toBe(
      'http://127.0.0.1:4010/feed.xml',
    );
  });

  it('reads the escape hatch from ALLOW_PRIVATE_FEED_HOSTS when no option is given', () => {
    const original = process.env['ALLOW_PRIVATE_FEED_HOSTS'];
    process.env['ALLOW_PRIVATE_FEED_HOSTS'] = 'true';

    try {
      expect(normalizeFeedUrl('http://127.0.0.1:4010/feed.xml')).toBe('http://127.0.0.1:4010/feed.xml');
    } finally {
      if (original === undefined) {
        delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];
      } else {
        process.env['ALLOW_PRIVATE_FEED_HOSTS'] = original;
      }
    }
  });
});

describe('buildNormalizedFeedUrlHash', () => {
  it('returns stable hash for equivalent urls', () => {
    const a = normalizeFeedUrl('https://EXAMPLE.com:443/path/');
    const b = normalizeFeedUrl('https://example.com/path');

    expect(buildNormalizedFeedUrlHash(a)).toBe(buildNormalizedFeedUrlHash(b));
  });

  it('returns different hash for different canonical urls', () => {
    const a = normalizeFeedUrl('https://example.com/feed.xml?lang=es');
    const b = normalizeFeedUrl('https://example.com/feed.xml?lang=en');

    expect(buildNormalizedFeedUrlHash(a)).not.toBe(buildNormalizedFeedUrlHash(b));
  });
});
