import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { MetricsService } from '../../observability/metrics.service';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';
import { SettingsRepository } from '../../settings/settings.repository';
import { DEFAULT_TELEGRAM_DELIVERY_MODE } from '../../settings/settings.types';
import { TelegramBotTokenResolverService } from '../../settings/telegram-bot-token-resolver.service';
import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class ProcessAlertDeliveryUseCase {
  private readonly logger = new Logger(ProcessAlertDeliveryUseCase.name);

  constructor(
    private readonly alertsRepository: AlertsRepository,
    private readonly metricsService: MetricsService,
    private readonly settingsRepository: SettingsRepository,
    private readonly telegramBotTokenResolverService: TelegramBotTokenResolverService,
    private readonly appConfigService: AppConfigService,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  async execute(input: { alertId: number; attemptNumber: number; willRetry: boolean }): Promise<void> {
    const alert = await this.alertsRepository.findById(input.alertId);

    if (!alert) {
      throw new NotFoundException('alert_not_found');
    }

    if (alert.sent) {
      return;
    }

    const tenantSettings = await this.settingsRepository.getByTenantId(alert.tenantId);
    const notifierUrl = tenantSettings?.webhookNotifierUrl ?? this.appConfigService.webhookNotifierUrl ?? null;
    const recipientEmails = tenantSettings?.recipientEmails ?? [];
    const telegramChatIds = tenantSettings?.telegramChatIds ?? [];
    const telegramDeliveryMode = tenantSettings?.telegramDeliveryMode ?? DEFAULT_TELEGRAM_DELIVERY_MODE;
    const telegramBotToken = this.telegramBotTokenResolverService.resolveForTenant({ tenantId: alert.tenantId, settings: tenantSettings });
    const shouldSendWebhook = Boolean(notifierUrl);
    const shouldSendEmail = recipientEmails.length > 0 && this.alertNotifier.isEmailEnabled();
    const shouldSendTelegram = telegramChatIds.length > 0 && this.alertNotifier.isTelegramEnabled(telegramBotToken) && telegramDeliveryMode === 'instant';
    const shouldQueueTelegramDigest =
      telegramChatIds.length > 0 && this.alertNotifier.isTelegramEnabled(telegramBotToken) && telegramDeliveryMode === 'digest_10m';

    if ((!shouldSendWebhook && !shouldSendEmail && !shouldSendTelegram && !shouldQueueTelegramDigest) || !this.alertNotifier.isEnabled()) {
      await this.alertsRepository.markDeliveryDisabled(input.alertId);
      return;
    }

    try {
      const channelErrors: string[] = [];

      if (shouldSendWebhook && notifierUrl) {
        try {
          await this.alertNotifier.sendWebhook(alert, notifierUrl);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_webhook_failure';
          channelErrors.push(`webhook:${message}`);
        }
      }

      if (shouldSendEmail) {
        try {
          await this.alertNotifier.sendEmail(alert, recipientEmails);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_email_failure';
          channelErrors.push(`email:${message}`);
        }
      }

      if (shouldSendTelegram) {
        for (const chatId of telegramChatIds) {
          try {
            await this.alertNotifier.sendTelegram(alert, chatId, telegramBotToken);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown_telegram_failure';
            channelErrors.push(`telegram:${chatId}:${message}`);
          }
        }
      }

      if (shouldQueueTelegramDigest) {
        await this.alertsRepository.queueTelegramDigestItems({
          alertId: input.alertId,
          tenantId: alert.tenantId,
          chatIds: telegramChatIds,
        });
      }

      if (channelErrors.length > 0) {
        throw new Error(`notification_channels_failed:${channelErrors.join('|')}`);
      }

      const firstSuccessfulDelivery = await this.alertsRepository.markSent(input.alertId, input.attemptNumber);

      if (firstSuccessfulDelivery) {
        this.metricsService.incrementAlertsSent(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_delivery_failure';
      await this.alertsRepository.markDeliveryFailure(input.alertId, {
        attemptNumber: input.attemptNumber,
        error: message,
        willRetry: input.willRetry,
      });
      this.logger.warn(`Alert ${input.alertId} delivery attempt ${input.attemptNumber} failed: ${message}`);
      throw error;
    }
  }
}
