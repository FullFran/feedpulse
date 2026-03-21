import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../shared/config/app-config.module';

import { ALERT_NOTIFIER } from './domain/alert-notifier.port';
import { NoopAlertNotifier } from './infrastructure/noop-alert.notifier';
import { WebhookAlertNotifier } from './infrastructure/webhook-alert.notifier';

@Module({
  imports: [AppConfigModule],
  providers: [
    NoopAlertNotifier,
    WebhookAlertNotifier,
    {
      provide: ALERT_NOTIFIER,
      inject: [WebhookAlertNotifier, NoopAlertNotifier],
      useFactory: (webhookAlertNotifier: WebhookAlertNotifier, noopAlertNotifier: NoopAlertNotifier) =>
        (webhookAlertNotifier.isEnabled() ? webhookAlertNotifier : noopAlertNotifier),
    },
  ],
  exports: [ALERT_NOTIFIER],
})
export class NotificationsModule {}
