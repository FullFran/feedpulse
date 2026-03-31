import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertNotificationPayload, AlertNotifierPort } from '../domain/alert-notifier.port';

const EMAIL_SUBJECT_MAX_LENGTH = 120;
const EMAIL_TITLE_MAX_LENGTH = 70;

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

    const { subject, text, html } = this.buildAlertEmail(alert);

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipientEmails,
        subject,
        text,
        html,
      }),
      signal: AbortSignal.timeout(this.appConfigService.webhookNotifierTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`email_delivery_failed_${response.status}`);
    }
  }

  private buildAlertEmail(alert: AlertNotificationPayload): { subject: string; text: string; html: string } {
    const title = alert.entry.title ?? '-';
    const link = alert.entry.link ?? '-';
    const includeKeywords = alert.rule.includeKeywords.join(', ') || '-';
    const excludeKeywords = alert.rule.excludeKeywords.join(', ') || '-';
    const createdAt = this.formatDateEs(alert.createdAt);

    const subjectBase = `Feedpulse: ${alert.rule.name} — ${this.truncate(title, EMAIL_TITLE_MAX_LENGTH)}`;
    const subject = this.truncate(subjectBase, EMAIL_SUBJECT_MAX_LENGTH);

    const text = [
      'Hola,',
      '',
      'Se detectó una nueva coincidencia para tu regla de monitoreo.',
      '',
      'Resumen de la alerta',
      '--------------------',
      `Título: ${title}`,
      `Enlace: ${link}`,
      `Regla: ${alert.rule.name}`,
      `Palabras clave incluidas: ${includeKeywords}`,
      `Palabras clave excluidas: ${excludeKeywords}`,
      `Fecha: ${createdAt}`,
      `Tenant: ${alert.tenantId}`,
      '',
      'Saludos,',
      'Feedpulse',
    ].join('\n');

    const titleEscaped = this.escapeHtml(title);
    const linkEscaped = this.escapeHtml(link);
    const ruleEscaped = this.escapeHtml(alert.rule.name);
    const includeEscaped = this.escapeHtml(includeKeywords);
    const excludeEscaped = this.escapeHtml(excludeKeywords);
    const dateEscaped = this.escapeHtml(createdAt);
    const tenantEscaped = this.escapeHtml(alert.tenantId);

    const html = [
      '<!doctype html>',
      '<html lang="es">',
      '<body style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      '<p>Hola,</p>',
      '<p>Se detectó una nueva coincidencia para tu regla de monitoreo.</p>',
      '<h2 style="margin:24px 0 12px 0;font-size:18px;">Resumen de la alerta</h2>',
      '<table style="border-collapse:collapse;">',
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Título:</strong></td><td>${titleEscaped}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Enlace:</strong></td><td>${
        link === '-' ? '-' : `<a href="${linkEscaped}">${linkEscaped}</a>`
      }</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Regla:</strong></td><td>${ruleEscaped}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Palabras clave incluidas:</strong></td><td>${includeEscaped}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Palabras clave excluidas:</strong></td><td>${excludeEscaped}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Fecha:</strong></td><td>${dateEscaped}</td></tr>`,
      `<tr><td style="padding:4px 12px 4px 0;"><strong>Tenant:</strong></td><td>${tenantEscaped}</td></tr>`,
      '</table>',
      '<p style="margin-top:20px;">Saludos,<br/>Feedpulse</p>',
      '</body>',
      '</html>',
    ].join('');

    return { subject, text, html };
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  private formatDateEs(rawDate: string): string {
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) {
      return rawDate;
    }

    return `${new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date)} UTC`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
