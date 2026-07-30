import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';
import {
  EMAIL_QUOTA_EXCEEDED_REASON,
  EmailRateLimitService,
} from '../../notifications/infrastructure/email-rate-limit.service';
import { MetricsService } from '../../observability/metrics.service';
import { SettingsRepository } from '../../settings/settings.repository';
import { DEFAULT_TELEGRAM_DELIVERY_MODE } from '../../settings/settings.types';
import { TelegramBotTokenResolverService } from '../../settings/telegram-bot-token-resolver.service';
import { AlertsRepository, AlertChannelDeliveryStatus, DeliveryChannel } from '../alerts.repository';

/**
 * The slice of `MetricsService` this use case writes to.
 *
 * `incrementAlertDeliveryChannelFailure` (backing
 * `rss_alert_delivery_channel_failures_total{channel}`) is added to
 * `MetricsService` by the observability pass; it is optional here so this file
 * is correct both before and after that lands, and starts exporting the counter
 * with no further edit. Channel failures are only string-joined into the thrown
 * error otherwise, which monitoring cannot see.
 */
interface AlertDeliveryMetricsRecorder {
  incrementAlertsSent(count: number): void;
  incrementAlertDeliveryChannelFailure?(channel: DeliveryChannel): void;
}

@Injectable()
export class ProcessAlertDeliveryUseCase {
  private readonly logger = new Logger(ProcessAlertDeliveryUseCase.name);

  constructor(
    private readonly alertsRepository: AlertsRepository,
    private readonly metricsService: MetricsService,
    private readonly settingsRepository: SettingsRepository,
    private readonly telegramBotTokenResolverService: TelegramBotTokenResolverService,
    private readonly appConfigService: AppConfigService,
    private readonly emailRateLimitService: EmailRateLimitService,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  async execute(input: { alertId: number; attemptNumber: number; willRetry: boolean }): Promise<void> {
    const alert = await this.alertsRepository.findByIdForWorker(input.alertId);

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
    const telegramBotToken = this.telegramBotTokenResolverService.resolveForTenant({
      tenantId: alert.tenantId,
      settings: tenantSettings,
    });

    // Determine which channels should be attempted (based on config AND current status)
    // Webhook: only if URL is configured AND status is not already 'sent'
    const shouldAttemptWebhook = Boolean(notifierUrl) && channelStatus.webhook !== 'sent';
    // Email: only if configured AND not already sent
    const shouldAttemptEmail =
      recipientEmails.length > 0 && this.alertNotifier.isEmailEnabled() && channelStatus.email !== 'sent';
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
      // Retryable channel failures: the queue re-runs the job for these.
      const channelErrors: string[] = [];
      // Terminal channel failures: a retry cannot fix them today, so they are
      // recorded on the alert instead of being thrown at the queue.
      const terminalChannelErrors: string[] = [];

      // Attempt webhook delivery only if needed
      if (shouldAttemptWebhook && notifierUrl) {
        try {
          await this.alertNotifier.sendWebhook(alert, notifierUrl);
          await this.alertsRepository.markChannelDelivered(input.alertId, 'webhook');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown_webhook_failure';
          channelErrors.push(`webhook:${message}`);
          this.recordChannelFailure('webhook');
        }
      }

      // Attempt email delivery only if needed, and only if the tenant still has
      // daily quota left. The reservation is atomic, so concurrent workers
      // cannot all squeeze past the last slot.
      if (shouldAttemptEmail) {
        const quota = await this.emailRateLimitService.reserve(alert.tenantId);

        if (!quota.allowed) {
          // Dropping the email silently would be the worst outcome: the alert
          // would sit on `pending` forever and nobody would learn why. Record a
          // terminal channel failure with the reason instead.
          terminalChannelErrors.push(`email:${EMAIL_QUOTA_EXCEEDED_REASON}:daily_limit_${quota.limit}`);
          await this.alertsRepository.markChannelFailed(input.alertId, 'email');
          this.recordChannelFailure('email');
          this.logger.warn(
            `Alert ${input.alertId} email skipped: tenant ${alert.tenantId} reached its daily quota of ${quota.limit}`,
          );
        } else {
          try {
            await this.alertNotifier.sendEmail(alert, recipientEmails);
            await this.alertsRepository.markChannelDelivered(input.alertId, 'email');
          } catch (error) {
            // The send never happened, so the reserved slot goes back: a broken
            // transport must not eat the tenant's allowance for the whole day.
            await this.emailRateLimitService.release(alert.tenantId);
            const message = error instanceof Error ? error.message : 'unknown_email_failure';
            channelErrors.push(`email:${message}`);
            this.recordChannelFailure('email');
          }
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
            this.recordChannelFailure('telegram');
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
        throw new Error(`notification_channels_failed:${[...channelErrors, ...terminalChannelErrors].join('|')}`);
      }

      if (terminalChannelErrors.length > 0) {
        // Nothing retryable is left, so the job must not be failed at the queue:
        // re-running it would only re-hit the same exhausted quota and delay the
        // channels that already succeeded. The alert carries the reason.
        await this.alertsRepository.markDeliveryFailure(input.alertId, {
          attemptNumber: input.attemptNumber,
          error: `notification_channels_failed:${terminalChannelErrors.join('|')}`,
          willRetry: false,
        });
        this.logger.warn(
          `Alert ${input.alertId} delivery incomplete, not retryable: ${terminalChannelErrors.join('|')}`,
        );
        return;
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

  private recordChannelFailure(channel: DeliveryChannel): void {
    const recorder: AlertDeliveryMetricsRecorder = this.metricsService;

    recorder.incrementAlertDeliveryChannelFailure?.(channel);
  }
}
