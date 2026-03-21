import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertNotificationPayload, AlertNotifierPort } from '../domain/alert-notifier.port';

@Injectable()
export class WebhookAlertNotifier implements AlertNotifierPort {
  constructor(@Inject(AppConfigService) private readonly appConfigService: AppConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.appConfigService.webhookNotifierUrl);
  }

  async send(alert: AlertNotificationPayload): Promise<void> {
    const url = this.appConfigService.webhookNotifierUrl;

    if (!url) {
      return;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ alert }),
      signal: AbortSignal.timeout(this.appConfigService.webhookNotifierTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`webhook_delivery_failed_${response.status}`);
    }
  }
}
