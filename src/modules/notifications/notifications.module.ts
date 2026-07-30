import { Module } from '@nestjs/common';
import { AppConfigModule } from '../../shared/config/app-config.module';
import { ALERT_NOTIFIER } from './domain/alert-notifier.port';
import { EmailRateLimitService } from './infrastructure/email-rate-limit.service';
import { NoopAlertNotifier } from './infrastructure/noop-alert.notifier';
import { WebhookAlertNotifier } from './infrastructure/webhook-alert.notifier';

/**
 * `EmailRateLimitService` depends on `REDIS_CONNECTION`, which `QueueModule`
 * provides globally, so it needs no import here — but it does mean this module
 * can only be instantiated inside an application that wires `QueueModule`.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    NoopAlertNotifier,
    WebhookAlertNotifier,
    EmailRateLimitService,
    {
      provide: ALERT_NOTIFIER,
      inject: [WebhookAlertNotifier, NoopAlertNotifier],
      useFactory: (webhookAlertNotifier: WebhookAlertNotifier, noopAlertNotifier: NoopAlertNotifier) =>
        webhookAlertNotifier.isEnabled() ? webhookAlertNotifier : noopAlertNotifier,
    },
  ],
  exports: [ALERT_NOTIFIER, EmailRateLimitService],
})
export class NotificationsModule {}
