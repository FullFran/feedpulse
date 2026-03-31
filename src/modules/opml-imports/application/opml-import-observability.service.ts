import { Injectable } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';

import { SHARED_METRICS_REGISTRY } from '../../observability/metrics-registry';

type OpmlJobStage = 'parse' | 'apply';
type OpmlJobStatus = 'success' | 'error';

@Injectable()
export class OpmlImportObservabilityService {
  private readonly jobDurationMs = this.getOrCreateDurationHistogram();
  private readonly jobErrorsTotal = this.getOrCreateErrorCounter();

  startJobTimer(stage: OpmlJobStage): (status: OpmlJobStatus, errorCode?: string) => number {
    const startedAt = process.hrtime.bigint();

    return (status: OpmlJobStatus, errorCode?: string) => {
      const endedAt = process.hrtime.bigint();
      const durationMs = Number(endedAt - startedAt) / 1_000_000;

      this.jobDurationMs.labels(stage, status).observe(durationMs);
      if (status === 'error') {
        this.jobErrorsTotal.labels(stage, errorCode ?? 'unknown').inc();
      }

      return durationMs;
    };
  }

  private getOrCreateDurationHistogram(): Histogram<'stage' | 'status'> {
    const existing = SHARED_METRICS_REGISTRY.getSingleMetric('rss_opml_job_duration_ms');
    if (existing) {
      return existing as Histogram<'stage' | 'status'>;
    }

    return new Histogram({
      name: 'rss_opml_job_duration_ms',
      help: 'OPML parse/apply job duration in milliseconds',
      labelNames: ['stage', 'status'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [SHARED_METRICS_REGISTRY],
    });
  }

  private getOrCreateErrorCounter(): Counter<'stage' | 'error_code'> {
    const existing = SHARED_METRICS_REGISTRY.getSingleMetric('rss_opml_job_errors_total');
    if (existing) {
      return existing as Counter<'stage' | 'error_code'>;
    }

    return new Counter({
      name: 'rss_opml_job_errors_total',
      help: 'OPML parse/apply job errors by stage and error code',
      labelNames: ['stage', 'error_code'],
      registers: [SHARED_METRICS_REGISTRY],
    });
  }
}
