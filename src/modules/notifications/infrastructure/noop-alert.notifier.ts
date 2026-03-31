import { Injectable } from '@nestjs/common';

import { AlertNotificationPayload, AlertNotifierPort, TelegramDigestPayload } from '../domain/alert-notifier.port';

@Injectable()
export class NoopAlertNotifier implements AlertNotifierPort {
  isEnabled(): boolean {
    return false;
  }

  isEmailEnabled(): boolean {
    return false;
  }

  isTelegramEnabled(): boolean {
    return false;
  }

  async sendWebhook(_alert: AlertNotificationPayload, _destinationUrl: string): Promise<void> {
    return undefined;
  }

  async sendEmail(_alert: AlertNotificationPayload, _recipientEmails: string[]): Promise<void> {
    return undefined;
  }

  async sendTelegram(_alert: AlertNotificationPayload, _chatId: string): Promise<void> {
    return undefined;
  }

  async sendTelegramDigest(_payload: TelegramDigestPayload): Promise<void> {
    return undefined;
  }
}
