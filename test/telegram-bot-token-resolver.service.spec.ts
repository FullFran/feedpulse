import { BadRequestException } from '@nestjs/common';

import { TenantSettings } from '../src/modules/settings/settings.repository';
import { TelegramBotTokenResolverService } from '../src/modules/settings/telegram-bot-token-resolver.service';
import { TenantSecretsService } from '../src/modules/settings/tenant-secrets.service';
import { AppConfigService } from '../src/shared/config/app-config.service';

describe('TenantSecretsService + TelegramBotTokenResolverService', () => {
  const tenantSettingsBase: Omit<TenantSettings, 'telegramBotTokenEncrypted' | 'telegramBotTokenConfigured'> = {
    tenantId: 'tenant_a',
    webhookNotifierUrl: null,
    recipientEmails: [],
    telegramChatIds: [],
    telegramDeliveryMode: 'instant',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('throws when encrypting tenant token without master key', () => {
    const appConfig = { tenantSecretsMasterKey: undefined } as AppConfigService;
    const service = new TenantSecretsService(appConfig);

    expect(() => service.encryptTelegramBotToken('tenant_token')).toThrow(BadRequestException);
  });

  it('decrypts tenant token and resolver prefers it over global', () => {
    const appConfig = { tenantSecretsMasterKey: 'master_test', telegramBotToken: 'global_fallback' } as AppConfigService;
    const secretService = new TenantSecretsService(appConfig);
    const resolver = new TelegramBotTokenResolverService(appConfig, secretService);
    const encrypted = secretService.encryptTelegramBotToken('tenant_token');

    const resolved = resolver.resolveForTenant({
      tenantId: 'tenant_a',
      settings: {
        ...tenantSettingsBase,
        telegramBotTokenConfigured: true,
        telegramBotTokenEncrypted: encrypted,
      },
    });

    expect(resolved).toBe('tenant_token');
  });

  it('falls back to global token when tenant token decrypt fails', () => {
    const appConfig = { tenantSecretsMasterKey: 'master_test', telegramBotToken: 'global_fallback' } as AppConfigService;
    const secretService = new TenantSecretsService(appConfig);
    const resolver = new TelegramBotTokenResolverService(appConfig, secretService);

    const resolved = resolver.resolveForTenant({
      tenantId: 'tenant_a',
      settings: {
        ...tenantSettingsBase,
        telegramBotTokenConfigured: true,
        telegramBotTokenEncrypted: {
          ciphertext: 'invalid',
          iv: 'invalid',
          tag: 'invalid',
        },
      },
    });

    expect(resolved).toBe('global_fallback');
  });

  it('falls back safely to global token when master key is missing in decrypt path', () => {
    const appConfig = { tenantSecretsMasterKey: undefined, telegramBotToken: 'global_fallback' } as AppConfigService;
    const secretService = new TenantSecretsService(appConfig);
    const resolver = new TelegramBotTokenResolverService(appConfig, secretService);

    const resolved = resolver.resolveForTenant({
      tenantId: 'tenant_a',
      settings: {
        ...tenantSettingsBase,
        telegramBotTokenConfigured: true,
        telegramBotTokenEncrypted: {
          ciphertext: 'abc',
          iv: 'def',
          tag: 'ghi',
        },
      },
    });

    expect(resolved).toBe('global_fallback');
  });
});
