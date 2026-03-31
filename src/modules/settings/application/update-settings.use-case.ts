import { Injectable } from '@nestjs/common';

import { SettingsRepository } from '../settings.repository';

@Injectable()
export class UpdateSettingsUseCase {
  constructor(private readonly settingsRepository: SettingsRepository) {}

  async execute(input: { tenantId: string; webhookNotifierUrl: string | null }): Promise<{ webhookNotifierUrl: string | null }> {
    const settings = await this.settingsRepository.upsertWebhookNotifierUrl(input.tenantId, input.webhookNotifierUrl);

    return {
      webhookNotifierUrl: settings.webhookNotifierUrl,
    };
  }
}
