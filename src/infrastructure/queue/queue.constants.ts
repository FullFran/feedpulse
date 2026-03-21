export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
export const FETCH_FEED_QUEUE_TOKEN = Symbol('FETCH_FEED_QUEUE_TOKEN');
export const ALERT_DELIVERY_QUEUE_TOKEN = Symbol('ALERT_DELIVERY_QUEUE_TOKEN');

export const FETCH_FEED_QUEUE_NAME = 'fetch-feed';
export const ALERT_DELIVERY_QUEUE_NAME = 'alert-delivery';

export interface FetchFeedJobData {
  feedId: number;
  queuedAt: string;
  attempt: number;
}

export interface FetchFeedQueuePort {
  enqueue(job: FetchFeedJobData): Promise<void>;
}

export interface AlertDeliveryJobData {
  alertId: number;
  queuedAt: string;
  source: 'ingestion' | 'manual';
}

export interface AlertDeliveryQueuePort {
  enqueue(job: AlertDeliveryJobData): Promise<void>;
}
