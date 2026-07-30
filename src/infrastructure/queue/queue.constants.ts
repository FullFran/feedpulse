export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
export const FETCH_FEED_QUEUE_TOKEN = Symbol('FETCH_FEED_QUEUE_TOKEN');
export const ALERT_DELIVERY_QUEUE_TOKEN = Symbol('ALERT_DELIVERY_QUEUE_TOKEN');
export const OPML_PARSE_PREVIEW_QUEUE_TOKEN = Symbol('OPML_PARSE_PREVIEW_QUEUE_TOKEN');
export const OPML_APPLY_IMPORT_QUEUE_TOKEN = Symbol('OPML_APPLY_IMPORT_QUEUE_TOKEN');

export const FETCH_FEED_QUEUE_NAME = 'fetch-feed';
export const ALERT_DELIVERY_QUEUE_NAME = 'alert-delivery';
export const OPML_PARSE_PREVIEW_QUEUE_NAME = 'opml-parse-preview';
export const OPML_APPLY_IMPORT_QUEUE_NAME = 'opml-apply-import';

export interface FetchFeedJobData {
  feedId: number;
  queuedAt: string;
  attempt: number;
  /**
   * `scheduler` jobs share a stable, deduplicated job id (`feed-<id>`) so a tick can never
   * queue the same feed twice. `manual` jobs get a unique id instead, so an operator check
   * is never silently swallowed by deduplication against a scheduled job.
   * Defaults to `scheduler` when omitted.
   */
  source?: 'scheduler' | 'manual';
}

export interface FetchFeedEnqueueResult {
  jobId: string;
  /** True when the queue already held a job with this id, so nothing new was enqueued. */
  deduplicated: boolean;
}

export interface FetchFeedQueuePort {
  enqueue(job: FetchFeedJobData): Promise<FetchFeedEnqueueResult>;
}

export interface AlertDeliveryJobData {
  alertId: number;
  queuedAt: string;
  source: 'ingestion' | 'manual';
}

export interface AlertDeliveryQueuePort {
  enqueue(job: AlertDeliveryJobData): Promise<void>;
}

export interface OpmlParsePreviewJobData {
  importId: number;
  opmlXml: string;
}

export interface OpmlParsePreviewQueuePort {
  enqueue(job: OpmlParsePreviewJobData): Promise<void>;
}

export interface OpmlApplyImportJobData {
  importId: number;
  requestedAt: string;
}

export interface OpmlApplyImportQueuePort {
  enqueue(job: OpmlApplyImportJobData): Promise<void>;
}
