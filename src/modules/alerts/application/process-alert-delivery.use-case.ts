import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { MetricsService } from '../../observability/metrics.service';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';
import { SettingsRepository } from '../../settings/settings.repository';
import { DEFAULT_TELEGRAM_DELIVERY_MODE } from '../../settings/settings.types';
import { TelegramBotTokenResolverService } from '../../settings/telegram-bot-token-resolver.service';
import { AppConfigService } from '../../../shared/config/app-config.service';

import { AlertsRepository } from '../alerts.repository';
import { AlertChannelDeliveryStatus } from '../alerts.repository';

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

    // Get per-channel delivery status from the alert
    const channelStatus: AlertChannelDeliveryStatus = {
      webhook: alert.webhookDeliveryStatus,
      telegram: alert.telegramDeliveryStatus,
      email: alert.emailDeliveryStatus,
    };

    const tenantSettings = await this.settingsRepository.getByTenantId(alert.tenantId);
    const notifierUrl = tenantSettings?.webhookNotifierUrl ?? this.appConfigService.webhookNotifierUrl ?? null;
    const recipientEmails = tenantSettings?.recipientEmails ?? [];
    const telegramChatIds = tenantSettings?.telegramChatIds ?? [];
    const telegramDeliveryMode = tenantSettings?.telegramDeliveryMode ?? DEFAULT_TELEGRAM_DELIVERY_MODE;
    const telegramBotToken = this.telegramBotTokenResolverService.resolveForTenant({ tenantId: alert.tenantId, settings: tenantSettings });

    // Determine which channels should be attempted (based on config AND current status)
    // Webhook: only if URL is configured AND status is not already 'sent'
    const shouldAttemptWebhook = Boolean(notifierUrl) && channelStatus.webhook !== 'sent';
    // Email: only if configured AND not already sent
    const shouldAttemptEmail = recipientEmails.length > 0 && this.alertNotifier.isEmailEnabled() && channelStatus.email !== 'sent';
    // Telegram: only if configured AND not already sent
    const shouldSendTelegram =
      telegramChatIds.length > 0 &&
      this.alertNotifier.isTelegramEnabled(telegramBotToken) &&
      telegramDeliveryMode === 'instant' &&
      channelStatus.telegram !== 'sent';
    const shouldQueueTelegramDigest =
      telegramChatIds.length > 0 &&
      this.alertNotifier.isTelegramEnabled(telegramBotToken) &&
      telegramDeliveryMode === 'digest_10m' &&
      channelStatus.telegram !== 'sent';

    // If no channels need delivery and notifier is disabled, mark as disabled
    if (
      (!shouldAttemptWebhook && !shouldAttemptEmail && !shouldSendTelegram && !shouldQueueTelegramDigest) ||
      !this.alertNotifier.isEnabled()
    ) {
      await this.alertsRepository.markDeliveryDisabled(input.alertId);
      return;
    }

    try {
      const channelErrors: string[] = [];

      // Attempt webhook delivery only if needed
      if (shouldAttemptWebhook && notifierUrl) {
        try {
          await this.alertNotifier.sendWebhook(alert, notifierUrl);
          await this.alertsRepository.markChannelDelivered(input.alertId, 'webhook');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_webhook_failure';
          channelErrors.push(`webhook:${message}`);
        }
      }

      // Attempt email delivery only if needed
      if (shouldAttemptEmail) {
        try {
          await this.alertNotifier.sendEmail(alert, recipientEmails);
          await this.alertsRepository.markChannelDelivered(input.alertId, 'email');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_email_failure';
          channelErrors.push(`email:${message}`);
        }
      }

      // Attempt Telegram delivery only if needed
      if (shouldSendTelegram) {
        let telegramSucceededForAll = true;
        for (const chatId of telegramChatIds) {
          try {
            await this.alertNotifier.sendTelegram(alert, chatId, telegramBotToken);
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown_telegram_failure';
            channelErrors.push(`telegram:${chatId}:${message}`);
            telegramSucceededForAll = false;
          }
        }
        if (telegramSucceededForAll) {
          await this.alertsRepository.markChannelDelivered(input.alertId, 'telegram');
        }
      }

      // Queue Telegram digest if needed
      if (shouldQueueTelegramDigest) {
        await this.alertsRepository.queueTelegramDigestItems({
          alertId: input.alertId,
          tenantId: alert.tenantId,
          chatIds: telegramChatIds,
        });
      }

      // If any channel errors occurred, throw so the queue can retry failed channels
      if (channelErrors.length > 0) {
        throw new Error(`notification_channels_failed:${channelErrors.join('|')}`);
      }

      // Check if ALL required channels have succeeded (only mark "sent" when done)
      const finalStatus = await this.alertsRepository.checkAllChannelsDelivered(input.alertId, {
        hasWebhook: Boolean(notifierUrl),
        hasEmail: recipientEmails.length > 0,
        hasTelegram: telegramChatIds.length > 0 && telegramDeliveryMode === 'instant',
      });

      if (finalStatus.allDelivered) {
        const firstSuccessfulDelivery = await this.alertsRepository.markSent(input.alertId, input.attemptNumber);
        if (firstSuccessfulDelivery) {
          this.metricsService.incrementAlertsSent(1);
        }
      } else if (input.willRetry) {
        // Mark as retrying if there are still pending channels
        await this.alertsRepository.markDeliveryRetryPending(input.alertId, input.attemptNumber);
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