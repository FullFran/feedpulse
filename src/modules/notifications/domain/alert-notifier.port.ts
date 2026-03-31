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

export interface AlertNotifierPort {
  isEnabled(): boolean;
  send(alert: AlertNotificationPayload, destinationUrl?: string): Promise<void>;
}

export const ALERT_NOTIFIER = Symbol('ALERT_NOTIFIER');
