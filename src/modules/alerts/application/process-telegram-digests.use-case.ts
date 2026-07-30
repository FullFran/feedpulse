import { Inject, Injectable, Logger } from '@nestjs/common';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';
import { SettingsRepository } from '../../settings/settings.repository';
import { TelegramBotTokenResolverService } from '../../settings/telegram-bot-token-resolver.service';
import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class ProcessTelegramDigestsUseCase {
  private readonly logger = new Logger(ProcessTelegramDigestsUseCase.name);

  constructor(
    private readonly alertsRepository: AlertsRepository,
    private readonly settingsRepository: SettingsRepository,
    private readonly telegramBotTokenResolverService: TelegramBotTokenResolverService,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  /**
   * @returns how much was flushed, plus how many alerts had their Telegram
   *          channel converged to `'sent'` (including the ones repaired by the
   *          reconciliation pass), so the scheduler can log a real number
   *          instead of guessing.
   */
  async execute(
    input: { now?: Date; maxGroups?: number } = {},
  ): Promise<{ processedGroups: number; sentItems: number; alertsMarkedDelivered: number }> {
    if (!this.alertNotifier.isEnabled()) {
      return { processedGroups: 0, sentItems: 0, alertsMarkedDelivered: 0 };
    }

    // Repair first, flush second. A crash between "items marked sent" and
    // "alert channel marked sent" inside a previous sweep — and every alert
    // flushed by the versions of this use case that never marked the channel at
    // all — is healed here, before new work is added on top.
    let alertsMarkedDelivered = await this.reconcilePreviousSweeps();

    const nowIso = (input.now ?? new Date()).toISOString();
    const groups = await this.alertsRepository.listDueTelegramDigestGroups({
      nowIso,
      maxGroups: input.maxGroups ?? 30,
    });

    let processedGroups = 0;
    let sentItems = 0;

    for (const group of groups) {
      if (!group.items.length) {
        continue;
      }

      const tenantSettings = await this.settingsRepository.getByTenantId(group.tenantId);
      const telegramBotToken = this.telegramBotTokenResolverService.resolveForTenant({
        tenantId: group.tenantId,
        settings: tenantSettings,
      });
      if (!this.alertNotifier.isTelegramEnabled(telegramBotToken)) {
        continue;
      }

      try {
        await this.alertNotifier.sendTelegramDigest({
          tenantId: group.tenantId,
          chatId: group.chatId,
          windowLabel: `Ventana hasta ${new Date(group.scheduledFor).toLocaleString('es-ES', { timeZone: 'UTC' })} UTC`,
          telegramBotToken,
          items: group.items.map((item) => ({
            title: item.title,
            snippet: item.snippet,
            link: item.link,
          })),
        });

        // Marking the items and converging the alert channel happen together:
        // a digest that reached Telegram must never leave the alert reporting
        // `telegram_delivery_status = 'pending'` to the API and the dashboard.
        const { alertIdsDelivered } = await this.alertsRepository.markTelegramDigestGroupSent(
          group.items.map((item) => ({ digestItemId: item.digestItemId, alertId: item.alertId })),
        );

        alertsMarkedDelivered += alertIdsDelivered.length;
        processedGroups += 1;
        sentItems += group.items.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_telegram_digest_failure';
        this.logger.warn(`Telegram digest failed tenant=${group.tenantId} chat=${group.chatId}: ${message}`);
      }
    }

    return { processedGroups, sentItems, alertsMarkedDelivered };
  }

  /**
   * Best-effort repair pass. A reconciliation failure must never stop the sweep
   * that follows it: the digests still waiting in the queue matter more than
   * the bookkeeping of the ones already delivered.
   */
  private async reconcilePreviousSweeps(): Promise<number> {
    try {
      const { alertIdsDelivered } = await this.alertsRepository.reconcileTelegramDigestDeliveryStatus();

      if (alertIdsDelivered.length) {
        this.logger.log(
          `Reconciled telegram delivery status for ${alertIdsDelivered.length} already-flushed digest alert(s)`,
        );
      }

      return alertIdsDelivered.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_telegram_digest_reconcile_failure';
      this.logger.warn(`Telegram digest reconciliation failed: ${message}`);
      return 0;
    }
  }
}
