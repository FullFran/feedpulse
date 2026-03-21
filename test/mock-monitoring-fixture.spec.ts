import { buildFixtureStats, createRssDocument, feedKeyFromPath, normalizeFeedKey, paginate } from '../scripts/smoke/mock-monitoring-fixture';

describe('mock monitoring fixture helpers', () => {
  it('builds deterministic RSS for feed-specific paths', () => {
    const document = createRssDocument('feed-00042', 'http://127.0.0.1:4010');

    expect(document).toContain('RSS Monitor Fixture feed-00042');
    expect(document).toContain('AI launch update feed-00042');
    expect(document).toContain('fixture-feed-00042-item-1');
    expect(document).toContain('http://127.0.0.1:4010/feeds/feed-00042/rss.xml');
  });

  it('maps fixture paths and aggregates compact stats', () => {
    const stats = buildFixtureStats(
      [{ method: 'POST', path: '/webhook', headers: {}, rawBody: '{}', parsedBody: {}, timestamp: '2026-03-21T00:00:00.000Z' }],
      [
        { method: 'GET', path: '/feeds/feed-00001/rss.xml', statusCode: 200, timestamp: '2026-03-21T00:00:00.000Z' },
        { method: 'GET', path: '/feeds/feed-00001/rss.xml?probe=1', statusCode: 200, timestamp: '2026-03-21T00:00:01.000Z' },
        { method: 'GET', path: '/rss.xml', statusCode: 200, timestamp: '2026-03-21T00:00:02.000Z' },
        { method: 'POST', path: '/webhook', statusCode: 204, timestamp: '2026-03-21T00:00:03.000Z' },
      ],
    );

    expect(feedKeyFromPath('/feeds/feed-00001/rss.xml')).toBe('feed-00001');
    expect(feedKeyFromPath('/rss.xml')).toBe('smoke-default');
    expect(normalizeFeedKey('feed 00002')).toBe('feed-00002');
    expect(stats).toEqual({
      captures: 1,
      requests: 4,
      rssRequests: 3,
      webhookRequests: 1,
      uniqueFeedsServed: 2,
    });
  });

  it('supports bounded pagination for artifact samples', () => {
    const result = paginate([1, 2, 3, 4, 5], 1, 2);

    expect(result).toEqual({
      items: [2, 3],
      offset: 1,
      limit: 2,
    });
  });
});
