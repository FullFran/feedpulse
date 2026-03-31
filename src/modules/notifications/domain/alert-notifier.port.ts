export interface AlertNotificationPayload {
  id: string;
  tenantId: string;
  createdAt: string;
  sent: boolean;
  sentAt: string | null;
  entry: {
    id: string;
    title: string | null;
    link: string | null;
    content: string | null;
  };
  rule: {
    id: number;
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
  };
}

export interface TelegramDigestPayload {
  tenantId: string;
  chatId: string;
  windowLabel: string;
  telegramBotToken?: string;
  items: Array<{
    title: string | null;
    snippet: string | null;
    link: string | null;
  }>;
}

export interface AlertNotifierPort {
  isEnabled(): boolean;
  isEmailEnabled(): boolean;
  isTelegramEnabled(telegramBotToken?: string): boolean;
  sendWebhook(alert: AlertNotificationPayload, destinationUrl: string): Promise<void>;
  sendEmail(alert: AlertNotificationPayload, recipientEmails: string[]): Promise<void>;
  sendTelegram(alert: AlertNotificationPayload, chatId: string, telegramBotToken?: string): Promise<void>;
  sendTelegramDigest(payload: TelegramDigestPayload): Promise<void>;
}

export const ALERT_NOTIFIER = Symbol('ALERT_NOTIFIER');
