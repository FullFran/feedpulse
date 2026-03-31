import { Injectable } from '@nestjs/common';

import { SettingsRepository } from '../settings.repository';
import { TelegramDeliveryMode } from '../settings.types';

@Injectable()
export class UpdateSettingsUseCase {
  constructor(private readonly settingsRepository: SettingsRepository) {}

  async execute(input: {
    tenantId: string;
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
  }): Promise<{
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
  }> {
    const settings = await this.settingsRepository.upsertNotifierSettings({
      tenantId: input.tenantId,
      webhookNotifierUrl: input.webhookNotifierUrl,
      recipientEmails: input.recipientEmails,
      telegramChatIds: input.telegramChatIds,
      telegramDeliveryMode: input.telegramDeliveryMode,
    });

    return {
      webhookNotifierUrl: settings.webhookNotifierUrl,
      recipientEmails: settings.recipientEmails,
      telegramChatIds: settings.telegramChatIds,
      telegramDeliveryMode: settings.telegramDeliveryMode,
    };
  }
}
