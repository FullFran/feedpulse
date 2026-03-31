import { Injectable } from '@nestjs/common';

import { SettingsRepository } from '../settings.repository';

@Injectable()
export class GetSettingsUseCase {
  constructor(private readonly settingsRepository: SettingsRepository) {}

  async execute(tenantId: string): Promise<{ webhookNotifierUrl: string | null; recipientEmails: string[] }> {
    const settings = await this.settingsRepository.getByTenantId(tenantId);
    return {
      webhookNotifierUrl: settings?.webhookNotifierUrl ?? null,
      recipientEmails: settings?.recipientEmails ?? [],
    };
  }
}
