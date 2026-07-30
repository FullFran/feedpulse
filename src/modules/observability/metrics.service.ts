import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { FeedsRepository } from '../feeds/feeds.repository';
import { SHARED_METRICS_REGISTRY } from './metrics-registry';

/**
 * Delivery channels the per-channel failure counter is labelled by.
 *
 * Closed on purpose: `channel` must never carry a tenant id, an alert id or a
 * URL, or the counter's cardinality becomes unbounded.
 */
export type AlertDeliveryChannelLabel = 'webhook' | 'telegram' | 'email';

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
  // Before this existed, `ProcessAlertDeliveryUseCase` only string-joined the
  // per-channel errors into the message it threw, so "webhooks have been failing
  // for three days" was invisible to monitoring as long as another channel
  // succeeded.
  private readonly alertDeliveryChannelFailuresTotal = new Counter({
    name: 'rss_alert_delivery_channel_failures_total',
    help: 'Total per-channel alert delivery failures, including quota blocks',
    labelNames: ['channel'] as const,
    registers: [SHARED_METRICS_REGISTRY],
  });
  // The backlog counterpart to `rss_alerts_sent_total`: a counter only ever
  // grows, so it cannot answer "how many alerts are stuck right now".
  private readonly alertsUndelivered = new Gauge({
    name: 'rss_alerts_undelivered',
    help: 'Alerts whose delivery is still pending or has failed',
    registers: [SHARED_METRICS_REGISTRY],
  });

  constructor(
    private readonly feedsRepository: FeedsRepository,
    private readonly databaseService: DatabaseService,
  ) {
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

  incrementAlertDeliveryChannelFailure(channel: AlertDeliveryChannelLabel): void {
    this.alertDeliveryChannelFailuresTotal.inc({ channel });
  }

  async metrics(): Promise<string> {
    this.feedsActiveTotal.set(await this.feedsRepository.countByStatus('active'));
    this.feedsErrorTotal.set(await this.feedsRepository.countByStatus('error'));
    this.alertsUndelivered.set(await this.countUndeliveredAlerts());
    return SHARED_METRICS_REGISTRY.metrics();
  }

  /**
   * Deliberately NOT tenant-scoped: this is the operator's backlog, and adding a
   * `tenant` label would make the series cardinality grow with the customer
   * count. `health.controller.ts` already serves the tenant-scoped view.
   */
  private async countUndeliveredAlerts(): Promise<number> {
    const result = await this.databaseService.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts WHERE delivery_status IN ('pending', 'failed')`,
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  get contentType(): string {
    return SHARED_METRICS_REGISTRY.contentType;
  }
}
