interface CaptureRecord {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  parsedBody: unknown;
  timestamp: string;
}

interface RequestLogRecord {
  method: string;
  path: string;
  statusCode: number;
  timestamp: string;
}

interface FixtureStats {
  captures: number;
  requests: number;
  rssRequests: number;
  webhookRequests: number;
  uniqueFeedsServed: number;
}

const DEFAULT_FEED_KEY = 'smoke-default';

function normalizeFeedKey(feedKey: string): string {
  return feedKey.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || DEFAULT_FEED_KEY;
}

function feedKeyFromPath(pathname: string): string | null {
  if (pathname === '/rss.xml') {
    return DEFAULT_FEED_KEY;
  }

  const match = /^\/feeds\/([^/]+)\/rss\.xml$/.exec(pathname);
  if (!match) {
    return null;
  }

  return normalizeFeedKey(decodeURIComponent(match[1]));
}

function hashFeedKey(feedKey: string): number {
  let hash = 0;
  for (const char of feedKey) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function deterministicPubDate(feedKey: string): string {
  const base = Date.UTC(2026, 2, 20, 9, 0, 0);
  const offsetHours = hashFeedKey(feedKey) % (24 * 120);
  return new Date(base + offsetHours * 60 * 60 * 1000).toUTCString();
}

function buildFeedMetadata(feedKey: string): { title: string; guid: string; link: string; pubDate: string } {
  const normalized = normalizeFeedKey(feedKey);

  return {
    title: `AI launch update ${normalized}`,
    guid: `fixture-${normalized}-item-1`,
    link: `https://example.test/items/${normalized}`,
    pubDate: deterministicPubDate(normalized),
  };
}

function createRssDocument(feedKey: string, publicBaseUrl: string): string {
  const normalized = normalizeFeedKey(feedKey);
  const item = buildFeedMetadata(normalized);
  const feedPath = normalized === DEFAULT_FEED_KEY ? '/rss.xml' : `/feeds/${encodeURIComponent(normalized)}/rss.xml`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RSS Monitor Fixture ${normalized}</title>
    <description>Deterministic local feed fixture for smoke tests and benchmarks.</description>
    <link>${publicBaseUrl}${feedPath}</link>
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <guid>${item.guid}</guid>
      <description>LLM systems reached a new milestone for ${normalized}.</description>
      <pubDate>${item.pubDate}</pubDate>
    </item>
  </channel>
</rss>`;
}

function buildFixtureStats(captures: CaptureRecord[], requestLogs: RequestLogRecord[]): FixtureStats {
  const rssFeedKeys = new Set<string>();
  let rssRequests = 0;
  let webhookRequests = 0;

  for (const request of requestLogs) {
    const pathname = new URL(request.path, 'http://fixture.local').pathname;
    const feedKey = feedKeyFromPath(pathname);

    if (feedKey) {
      rssRequests += 1;
      rssFeedKeys.add(feedKey);
    }

    if (pathname === '/webhook') {
      webhookRequests += 1;
    }
  }

  return {
    captures: captures.length,
    requests: requestLogs.length,
    rssRequests,
    webhookRequests,
    uniqueFeedsServed: rssFeedKeys.size,
  };
}

function paginate<T>(items: T[], offset: number, limit: number): { items: T[]; offset: number; limit: number } {
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : items.length;

  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    offset: safeOffset,
    limit: safeLimit,
  };
}

export {
  DEFAULT_FEED_KEY,
  buildFeedMetadata,
  buildFixtureStats,
  createRssDocument,
  feedKeyFromPath,
  normalizeFeedKey,
  paginate,
};

export type { CaptureRecord, FixtureStats, RequestLogRecord };
