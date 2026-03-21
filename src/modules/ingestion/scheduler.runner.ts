import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';

import { AppConfigService } from '../../shared/config/app-config.service';

import { ScheduleDueFeedsUseCase } from './application/schedule-due-feeds.use-case';

@Injectable()
export class SchedulerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerRunner.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly scheduleDueFeedsUseCase: ScheduleDueFeedsUseCase,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.appConfigService.schedulerTickMs);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.scheduleDueFeedsUseCase.execute();
      this.logger.log(`Scheduled ${result.scheduled} feed jobs`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scheduler failure';
      this.logger.error(`Scheduler tick failed: ${message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
