import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

import { SHARED_METRICS_REGISTRY } from './metrics-registry';
import { FeedsRepository } from '../feeds/feeds.repository';

@Injectable()
export class MetricsService {
  private readonly feedsActiveTotal = new Gauge({
    name: 'rss_feeds_active_total',
    help: 'Active feeds count',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly feedsErrorTotal = new Gauge({
    name: 'rss_feeds_error_total',
    help: 'Feeds in error count',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly fetchDurationSeconds = new Histogram({
    name: 'rss_fetch_duration_seconds',
    help: 'Feed fetch duration in seconds',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly fetchDurationMs = new Histogram({
    name: 'rss_fetch_duration_ms',
    help: 'Feed fetch duration in milliseconds',
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly fetchErrorsTotal = new Counter({
    name: 'rss_fetch_errors_total',
    help: 'Total feed fetch errors',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly fetchTotal = new Counter({
    name: 'rss_fetch_total',
    help: 'Total feed fetch requests',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly entriesIngestedTotal = new Counter({
    name: 'rss_entries_ingested_total',
    help: 'Total entries persisted',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly alertsGeneratedTotal = new Counter({
    name: 'rss_alerts_generated_total',
    help: 'Total alerts generated',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly alertsSentTotal = new Counter({
    name: 'rss_alerts_sent_total',
    help: 'Total alerts delivered successfully',
    registers: [SHARED_METRICS_REGISTRY],
  });
  private readonly rateLimitBackoffTotal = new Counter({
    name: 'rss_rate_limit_backoff_total',
    help: 'Total rate limit backoff events (Retry-After or exponential)',
    registers: [SHARED_METRICS_REGISTRY],
  });

  constructor(private readonly feedsRepository: FeedsRepository) {
    // Default metrics are collected once in metrics-registry.ts; do not re-collect here
  }

  observeFetchDuration(valueMs: number): void {
    this.fetchDurationMs.observe(valueMs);
    this.fetchDurationSeconds.observe(valueMs / 1000);
    this.fetchTotal.inc();
  }

  incrementFetchErrors(): void {
    this.fetchErrorsTotal.inc();
  }

  incrementRateLimitBackoff(): void {
    this.rateLimitBackoffTotal.inc();
  }

  incrementEntriesInserted(count: number): void {
    if (count > 0) {
      this.entriesIngestedTotal.inc(count);
    }
  }

  incrementAlertsGenerated(count: number): void {
    if (count > 0) {
      this.alertsGeneratedTotal.inc(count);
    }
  }

  incrementAlertsSent(count: number): void {
    if (count > 0) {
      this.alertsSentTotal.inc(count);
    }
  }

  async metrics(): Promise<string> {
    this.feedsActiveTotal.set(await this.feedsRepository.countByStatus('active'));
    this.feedsErrorTotal.set(await this.feedsRepository.countByStatus('error'));
    return SHARED_METRICS_REGISTRY.metrics();
  }

  get contentType(): string {
    return SHARED_METRICS_REGISTRY.contentType;
  }
}
