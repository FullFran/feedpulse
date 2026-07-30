export interface FeedFetchResult {
  statusCode: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  durationMs: number;
  /**
   * URL that produced the final response after redirect following. Optional so
   * existing test doubles keep compiling; the HTTP adapter always sets it.
   */
  finalUrl?: string;
  /** Parsed `Retry-After` value (seconds) when the origin throttled us. */
  retryAfterSeconds?: number | null;
}

export interface FeedFetcherPort {
  fetch(
    url: string,
    options: { etag?: string | null; lastModified?: string | null; timeoutMs: number },
  ): Promise<FeedFetchResult>;
}

export const FEED_FETCHER = Symbol('FEED_FETCHER');
