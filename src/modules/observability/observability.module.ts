import { Module } from '@nestjs/common';

import { FeedsModule } from '../feeds/feeds.module';

import { HealthController } from './health.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [FeedsModule],
  controllers: [HealthController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
