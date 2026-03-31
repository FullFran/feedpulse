import { Injectable } from '@nestjs/common';

import { AlertNotificationPayload, AlertNotifierPort } from '../domain/alert-notifier.port';

@Injectable()
export class NoopAlertNotifier implements AlertNotifierPort {
  isEnabled(): boolean {
    return false;
  }

  isEmailEnabled(): boolean {
    return false;
  }

  async sendWebhook(_alert: AlertNotificationPayload, _destinationUrl: string): Promise<void> {
    return undefined;
  }

  async sendEmail(_alert: AlertNotificationPayload, _recipientEmails: string[]): Promise<void> {
    return undefined;
  }
}
