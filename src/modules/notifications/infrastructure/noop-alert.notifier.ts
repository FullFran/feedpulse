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

  isTelegramEnabled(_telegramBotToken?: string): boolean {
    return false;
  }

  // Null-object adapter: every send is a no-op. These are deliberately NOT
  // `async` — there is nothing to await, and marking them `async` would claim
  // asynchronous work that never happens. They still return a real Promise so
  // they satisfy the Promise-returning `AlertNotifierPort` contract.
  sendWebhook(_alert: AlertNotificationPayload, _destinationUrl: string): Promise<void> {
    return Promise.resolve();
  }

  sendEmail(_alert: AlertNotificationPayload, _recipientEmails: string[]): Promise<void> {
    return Promise.resolve();
  }

  sendTelegram(_alert: AlertNotificationPayload, _chatId: string, _telegramBotToken?: string): Promise<void> {
    return Promise.resolve();
  }

  sendTelegramDigest(_payload: TelegramDigestPayload): Promise<void> {
    return Promise.resolve();
  }
}
