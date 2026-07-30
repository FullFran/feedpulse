import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { AppConfigService } from '../../shared/config/app-config.service';
import { ProcessTelegramDigestsUseCase } from '../alerts/application/process-telegram-digests.use-case';
import { ReleaseStuckFeedsUseCase } from './application/release-stuck-feeds.use-case';
import { ScheduleDueFeedsUseCase } from './application/schedule-due-feeds.use-case';

@Injectable()
export class SchedulerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerRunner.name);
  private timer: NodeJS.Timeout | null = null;

  /**
   * The tick currently running, if any. Serves two purposes: it is the re-entrancy guard for
   * ticks that outlive SCHEDULER_TICK_MS (which used to overlap each other), and it is what
   * shutdown awaits so a tick in flight never enqueues into an already closing queue.
   */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly scheduleDueFeedsUseCase: ScheduleDueFeedsUseCase,
    private readonly releaseStuckFeedsUseCase: ReleaseStuckFeedsUseCase,
    private readonly processTelegramDigestsUseCase: ProcessTelegramDigestsUseCase,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
  ) {}

  async start(): Promise<void> {
    await this.runTick();
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.appConfigService.schedulerTickMs);
  }

  private runTick(): Promise<void> {
    if (this.inFlight) {
      this.logger.warn('Previous scheduler tick is still running; skipping this interval');
      return this.inFlight;
    }

    const running = this.tick().finally(() => {
      this.inFlight = null;
    });

    this.inFlight = running;

    return running;
  }

  private async tick(): Promise<void> {
    // Runs first: a feed stranded behind a dead worker is invisible to claimDueFeeds until
    // its claim is released, so sweeping before claiming keeps recovery within one tick.
    try {
      await this.releaseStuckFeedsUseCase.execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown stuck feed sweep failure';
      this.logger.error(`Stuck feed sweep failed: ${message}`);
    }

    try {
      const result = await this.scheduleDueFeedsUseCase.execute();
      this.logger.log(`Scheduled ${result.scheduled} feed jobs`);

      if (result.deduplicated > 0) {
        this.logger.warn(`Skipped ${result.deduplicated} feed job(s) already queued`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown scheduler failure';
      this.logger.error(`Scheduler tick failed: ${message}`);
    }

    try {
      const digest = await this.processTelegramDigestsUseCase.execute();
      if (digest.processedGroups > 0) {
        this.logger.log(`Sent ${digest.processedGroups} telegram digest group(s) with ${digest.sentItems} item(s)`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown telegram digest scheduler failure';
      this.logger.error(`Telegram digest tick failed: ${message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlight) {
      await this.inFlight;
    }
  }
}
