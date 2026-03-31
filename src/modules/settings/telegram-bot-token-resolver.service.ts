import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../shared/config/app-config.service';

import { TenantSettings } from './settings.repository';
import { TenantSecretsService } from './tenant-secrets.service';

@Injectable()
export class TelegramBotTokenResolverService {
  private readonly logger = new Logger(TelegramBotTokenResolverService.name);

  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly tenantSecretsService: TenantSecretsService,
  ) {}

  resolveForTenant(input: { tenantId: string; settings: TenantSettings | null }): string | undefined {
    const encrypted = input.settings?.telegramBotTokenEncrypted;

    if (encrypted) {
      try {
        return this.tenantSecretsService.decryptTelegramBotToken(encrypted);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'tenant_telegram_token_decrypt_failed';
        this.logger.warn(`Tenant telegram token ignored tenant=${input.tenantId} reason=${reason}`);
      }
    }

    return this.appConfigService.telegramBotToken;
  }
}
