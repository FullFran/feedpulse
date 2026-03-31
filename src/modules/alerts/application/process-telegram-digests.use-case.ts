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

  async execute(input: { now?: Date; maxGroups?: number } = {}): Promise<{ processedGroups: number; sentItems: number }> {
    if (!this.alertNotifier.isEnabled()) {
      return { processedGroups: 0, sentItems: 0 };
    }

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
      const telegramBotToken = this.telegramBotTokenResolverService.resolveForTenant({ tenantId: group.tenantId, settings: tenantSettings });
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

        await this.alertsRepository.markTelegramDigestItemsSent(group.items.map((item) => item.digestItemId));
        processedGroups += 1;
        sentItems += group.items.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_telegram_digest_failure';
        this.logger.warn(`Telegram digest failed tenant=${group.tenantId} chat=${group.chatId}: ${message}`);
      }
    }

    return { processedGroups, sentItems };
  }
}
