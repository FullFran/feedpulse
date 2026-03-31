import { Module } from '@nestjs/common';

import { GetSettingsUseCase } from './application/get-settings.use-case';
import { UpdateSettingsUseCase } from './application/update-settings.use-case';
import { SettingsController } from './http/settings.controller';
import { SettingsRepository } from './settings.repository';
import { TelegramBotTokenResolverService } from './telegram-bot-token-resolver.service';
import { TenantSecretsService } from './tenant-secrets.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsRepository, TenantSecretsService, TelegramBotTokenResolverService, GetSettingsUseCase, UpdateSettingsUseCase],
  exports: [SettingsRepository, TenantSecretsService, TelegramBotTokenResolverService],
})
export class SettingsModule {}
