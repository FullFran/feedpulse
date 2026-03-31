import { Injectable } from '@nestjs/common';

import { SettingsRepository } from '../settings.repository';

@Injectable()
export class UpdateSettingsUseCase {
  constructor(private readonly settingsRepository: SettingsRepository) {}

  async execute(input: {
    tenantId: string;
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
  }): Promise<{ webhookNotifierUrl: string | null; recipientEmails: string[] }> {
    const settings = await this.settingsRepository.upsertNotifierSettings({
      tenantId: input.tenantId,
      webhookNotifierUrl: input.webhookNotifierUrl,
      recipientEmails: input.recipientEmails,
    });

    return {
      webhookNotifierUrl: settings.webhookNotifierUrl,
      recipientEmails: settings.recipientEmails,
    };
  }
}
