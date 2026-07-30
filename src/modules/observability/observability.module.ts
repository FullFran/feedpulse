import { Module } from '@nestjs/common';
import { DeadLetterRepository } from '../../infrastructure/queue/dead-letter.repository';
import { FeedsModule } from '../feeds/feeds.module';
import { HealthController } from './health.controller';
import { MetricsService } from './metrics.service';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * `DeadLetterRepository` is registered here rather than in `QueueModule` because it
 * is consumed as observability (by `WorkerRunner`, alongside `QueueMetricsService`)
 * and because it only needs the globally exported `DatabaseService`, not the Redis
 * connection `QueueModule` owns.
 */
@Module({
  imports: [FeedsModule],
  controllers: [HealthController],
  providers: [MetricsService, QueueMetricsService, DeadLetterRepository],
  exports: [MetricsService, QueueMetricsService, DeadLetterRepository],
})
export class ObservabilityModule {}
