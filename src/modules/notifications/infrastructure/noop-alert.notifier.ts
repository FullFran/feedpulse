import { Injectable } from '@nestjs/common';

import { AlertNotificationPayload, AlertNotifierPort } from '../domain/alert-notifier.port';

@Injectable()
export class NoopAlertNotifier implements AlertNotifierPort {
  isEnabled(): boolean {
    return false;
  }

  async send(_alert: AlertNotificationPayload, _destinationUrl?: string): Promise<void> {
    return undefined;
  }
}
