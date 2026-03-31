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
