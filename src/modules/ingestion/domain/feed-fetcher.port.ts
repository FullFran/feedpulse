export interface FeedFetchResult {
  statusCode: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  durationMs: number;
}

export interface FeedFetcherPort {
  fetch(url: string, options: { etag?: string | null; lastModified?: string | null; timeoutMs: number }): Promise<FeedFetchResult>;
}

export const FEED_FETCHER = Symbol('FEED_FETCHER');
