import { Injectable } from '@nestjs/common';

import { SettingsRepository, TenantTelegramBotTokenOperation } from '../settings.repository';
import { TelegramDeliveryMode } from '../settings.types';
import { TenantSecretsService } from '../tenant-secrets.service';

@Injectable()
export class UpdateSettingsUseCase {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly tenantSecretsService: TenantSecretsService,
  ) {}

  async execute(input: {
    tenantId: string;
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
    telegramBotToken?: string | null;
    clearTelegramBotToken: boolean;
  }): Promise<{
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
    telegramBotTokenConfigured: boolean;
  }> {
    const tokenOperation = this.resolveTokenOperation(input);
    const telegramBotTokenEncrypted =
      tokenOperation === 'set' ? this.tenantSecretsService.encryptTelegramBotToken(input.telegramBotToken as string) : null;

    const settings = await this.settingsRepository.upsertNotifierSettings({
      tenantId: input.tenantId,
      webhookNotifierUrl: input.webhookNotifierUrl,
      recipientEmails: input.recipientEmails,
      telegramChatIds: input.telegramChatIds,
      telegramDeliveryMode: input.telegramDeliveryMode,
      telegramBotTokenOperation: tokenOperation,
      telegramBotTokenEncrypted,
    });

    return {
      webhookNotifierUrl: settings.webhookNotifierUrl,
      recipientEmails: settings.recipientEmails,
      telegramChatIds: settings.telegramChatIds,
      telegramDeliveryMode: settings.telegramDeliveryMode,
      telegramBotTokenConfigured: settings.telegramBotTokenConfigured,
    };
  }

  private resolveTokenOperation(input: { telegramBotToken?: string | null; clearTelegramBotToken: boolean }): TenantTelegramBotTokenOperation {
    if (input.clearTelegramBotToken || input.telegramBotToken === null) {
      return 'clear';
    }

    if (typeof input.telegramBotToken === 'string' && input.telegramBotToken.length > 0) {
      return 'set';
    }

    return 'unchanged';
  }
}
