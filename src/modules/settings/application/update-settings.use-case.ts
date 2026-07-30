import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { assertSafePublicUrl, resolveAllowPrivateFeedHosts } from '../../../shared/http/url-safety';
import { SettingsRepository, TenantTelegramBotTokenOperation } from '../settings.repository';
import { TelegramDeliveryMode } from '../settings.types';
import { TenantSecretsService } from '../tenant-secrets.service';

@Injectable()
export class UpdateSettingsUseCase {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly tenantSecretsService: TenantSecretsService,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
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
    // Write-time SSRF check: the webhook URL is fetched later by the notifier,
    // which validates again at request time (defence in depth).
    if (input.webhookNotifierUrl) {
      try {
        assertSafePublicUrl(input.webhookNotifierUrl, {
          allowPrivateHosts: resolveAllowPrivateFeedHosts(this.appConfigService),
        });
      } catch {
        throw new BadRequestException('unsafe_webhook_url');
      }
    }

    const tokenOperation = this.resolveTokenOperation(input);
    const telegramBotTokenEncrypted =
      tokenOperation === 'set'
        ? this.tenantSecretsService.encryptTelegramBotToken({
            tenantId: input.tenantId,
            token: input.telegramBotToken as string,
          })
        : null;

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

  private resolveTokenOperation(input: {
    telegramBotToken?: string | null;
    clearTelegramBotToken: boolean;
  }): TenantTelegramBotTokenOperation {
    if (input.clearTelegramBotToken || input.telegramBotToken === null) {
      return 'clear';
    }

    if (typeof input.telegramBotToken === 'string' && input.telegramBotToken.length > 0) {
      return 'set';
    }

    return 'unchanged';
  }
}
