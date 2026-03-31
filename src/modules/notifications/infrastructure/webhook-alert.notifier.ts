import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertNotificationPayload, AlertNotifierPort } from '../domain/alert-notifier.port';

@Injectable()
export class WebhookAlertNotifier implements AlertNotifierPort {
  constructor(@Inject(AppConfigService) private readonly appConfigService: AppConfigService) {}

  isEnabled(): boolean {
    return true;
  }

  isEmailEnabled(): boolean {
    return Boolean(this.appConfigService.resendApiKey && this.appConfigService.resendFromEmail);
  }

  async sendWebhook(alert: AlertNotificationPayload, destinationUrl: string): Promise<void> {
    const url = destinationUrl || this.appConfigService.webhookNotifierUrl;

    if (!url) return;

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

  async sendEmail(alert: AlertNotificationPayload, recipientEmails: string[]): Promise<void> {
    if (!recipientEmails.length) return;

    const apiKey = this.appConfigService.resendApiKey;
    const fromEmail = this.appConfigService.resendFromEmail;

    if (!apiKey || !fromEmail) {
      throw new Error('email_notifier_disabled');
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipientEmails,
        subject: `[Feedpulse] ${alert.rule.name} - ${alert.entry.title ?? 'Untitled entry'}`,
        text: [
          `tenantId: ${alert.tenantId}`,
          `rule: ${alert.rule.name}`,
          `entryTitle: ${alert.entry.title ?? '-'}`,
          `entryLink: ${alert.entry.link ?? '-'}`,
          `createdAt: ${alert.createdAt}`,
          `includeKeywords: ${alert.rule.includeKeywords.join(', ') || '-'}`,
          `excludeKeywords: ${alert.rule.excludeKeywords.join(', ') || '-'}`,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(this.appConfigService.webhookNotifierTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`email_delivery_failed_${response.status}`);
    }
  }
}
