import { Module } from '@nestjs/common';

import { GetSettingsUseCase } from './application/get-settings.use-case';
import { UpdateSettingsUseCase } from './application/update-settings.use-case';
import { SettingsController } from './http/settings.controller';
import { SettingsRepository } from './settings.repository';

@Module({
  controllers: [SettingsController],
  providers: [SettingsRepository, GetSettingsUseCase, UpdateSettingsUseCase],
  exports: [SettingsRepository],
})
export class SettingsModule {}
