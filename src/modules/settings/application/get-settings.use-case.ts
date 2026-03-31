import { Injectable } from '@nestjs/common';

import { SettingsRepository } from '../settings.repository';
import { DEFAULT_TELEGRAM_DELIVERY_MODE, TelegramDeliveryMode } from '../settings.types';

@Injectable()
export class GetSettingsUseCase {
  constructor(private readonly settingsRepository: SettingsRepository) {}

  async execute(tenantId: string): Promise<{
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
  }> {
    const settings = await this.settingsRepository.getByTenantId(tenantId);
    return {
      webhookNotifierUrl: settings?.webhookNotifierUrl ?? null,
      recipientEmails: settings?.recipientEmails ?? [],
      telegramChatIds: settings?.telegramChatIds ?? [],
      telegramDeliveryMode: settings?.telegramDeliveryMode ?? DEFAULT_TELEGRAM_DELIVERY_MODE,
    };
  }
}
