import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertNotificationPayload, AlertNotifierPort, TelegramDigestPayload } from '../domain/alert-notifier.port';

const EMAIL_SUBJECT_MAX_LENGTH = 120;
const EMAIL_TITLE_MAX_LENGTH = 70;
const EMAIL_SUMMARY_MAX_LENGTH = 260;
const TELEGRAM_TITLE_MAX_LENGTH = 120;
const TELEGRAM_SNIPPET_MAX_LENGTH = 180;

@Injectable()
export class WebhookAlertNotifier implements AlertNotifierPort {
  constructor(@Inject(AppConfigService) private readonly appConfigService: AppConfigService) {}

  isEnabled(): boolean {
    return true;
  }

  isEmailEnabled(): boolean {
    return Boolean(this.appConfigService.resendApiKey && this.appConfigService.resendFromEmail);
  }

  isTelegramEnabled(telegramBotToken?: string): boolean {
    return Boolean(telegramBotToken || this.appConfigService.telegramBotToken);
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

  async sendTelegram(alert: AlertNotificationPayload, chatId: string, telegramBotToken?: string): Promise<void> {
    const title = this.truncate(alert.entry.title?.trim() || 'Alerta sin título', TELEGRAM_TITLE_MAX_LENGTH);
    const snippet = this.summarizeTelegramContent(alert.entry.content);
    const lines = [
      '📰 Nueva alerta',
      title,
      snippet,
      alert.entry.link ? `🔗 ${alert.entry.link}` : null,
    ].filter(Boolean) as string[];

    await this.sendTelegramMessage(chatId, lines.join('\n'), telegramBotToken);
  }

  async sendTelegramDigest(payload: TelegramDigestPayload): Promise<void> {
    const lines: string[] = [`📬 Resumen de alertas (${payload.items.length})`, payload.windowLabel];

    payload.items.slice(0, 12).forEach((item, index) => {
      const title = this.truncate(item.title?.trim() || 'Sin título', TELEGRAM_TITLE_MAX_LENGTH);
      const snippet = this.summarizeTelegramContent(item.snippet);
      lines.push(`${index + 1}. ${title}`);
      if (snippet) {
        lines.push(`   ${snippet}`);
      }
      if (item.link) {
        lines.push(`   🔗 ${item.link}`);
      }
    });

    if (payload.items.length > 12) {
      lines.push(`…y ${payload.items.length - 12} alerta(s) más.`);
    }

    await this.sendTelegramMessage(payload.chatId, lines.join('\n'), payload.telegramBotToken);
  }

  private buildAlertEmail(alert: AlertNotificationPayload): { subject: string; text: string; html: string } {
    const title = alert.entry.title ?? '-';
    const link = alert.entry.link ?? '-';
    const summary = this.summarizeContent(alert.entry.content);
    const includeKeywords = alert.rule.includeKeywords.join(', ') || '-';
    const createdAt = this.formatDateEs(alert.createdAt);

    const subjectBase = `Nueva alerta: ${this.truncate(title, EMAIL_TITLE_MAX_LENGTH)}`;
    const subject = this.truncate(subjectBase, EMAIL_SUBJECT_MAX_LENGTH);

    const text = [
      'Hola,',
      '',
      'Se detectó una noticia nueva que coincide con tu alerta.',
      '',
      'Resumen',
      '-------',
      `Título: ${title}`,
      `Entradilla: ${summary}`,
      `Enlace: ${link}`,
      `Regla: ${alert.rule.name}`,
      `Palabras clave: ${includeKeywords}`,
      `Fecha: ${createdAt}`,
      '',
      'Saludos,',
      'Feedpulse',
    ].join('\n');

    const titleEscaped = this.escapeHtml(title);
    const linkEscaped = this.escapeHtml(link);
    const summaryEscaped = this.escapeHtml(summary);
    const ruleEscaped = this.escapeHtml(alert.rule.name);
    const includeEscaped = this.escapeHtml(includeKeywords);
    const dateEscaped = this.escapeHtml(createdAt);

    const html = [
      '<!doctype html>',
      '<html lang="es">',
      '<body style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">',
      '<p>Hola,</p>',
      '<p>Se detectó una noticia nueva que coincide con tu alerta.</p>',
      '<h2 style="margin:22px 0 10px 0;font-size:18px;">Resumen</h2>',
      `<p style="margin:0 0 8px 0;"><strong>${titleEscaped}</strong></p>`,
      `<p style="margin:0 0 14px 0;color:#334155;">${summaryEscaped}</p>`,
      link === '-'
        ? '<p style="margin:0 0 14px 0;"><strong>Enlace:</strong> -</p>'
        : `<p style="margin:0 0 14px 0;"><a href="${linkEscaped}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;">Leer noticia</a></p>`,
      '<hr style="border:none;border-top:1px solid #e2e8f0;margin:14px 0;"/>',
      `<p style="margin:0 0 4px 0;"><strong>Regla:</strong> ${ruleEscaped}</p>`,
      `<p style="margin:0 0 4px 0;"><strong>Palabras clave:</strong> ${includeEscaped}</p>`,
      `<p style="margin:0 0 4px 0;"><strong>Fecha:</strong> ${dateEscaped}</p>`,
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

  private summarizeContent(content: string | null): string {
    if (!content) {
      return 'No hay entradilla disponible.';
    }

    const compact = content.replaceAll(/\s+/g, ' ').trim();
    if (!compact) {
      return 'No hay entradilla disponible.';
    }

    return this.truncate(compact, EMAIL_SUMMARY_MAX_LENGTH);
  }

  private summarizeTelegramContent(content: string | null): string | null {
    if (!content) {
      return null;
    }

    const compact = content.replaceAll(/\s+/g, ' ').trim();
    if (!compact) {
      return null;
    }

    return this.truncate(compact, TELEGRAM_SNIPPET_MAX_LENGTH);
  }

  private async sendTelegramMessage(chatId: string, text: string, telegramBotToken?: string): Promise<void> {
    const token = telegramBotToken || this.appConfigService.telegramBotToken;
    if (!token) {
      throw new Error('telegram_notifier_disabled');
    }

    const baseUrl = this.appConfigService.telegramApiUrl.replace(/\/$/, '');
    const url = `${baseUrl}/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(this.appConfigService.webhookNotifierTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`telegram_delivery_failed_${response.status}`);
    }

    const json = (await response.json().catch(() => null)) as { ok?: boolean } | null;
    if (json && json.ok === false) {
      throw new Error('telegram_delivery_failed_api_error');
    }
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
