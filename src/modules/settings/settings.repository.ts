import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';

interface TenantSettingsRow {
  tenant_id: string;
  webhook_notifier_url: string | null;
  recipient_emails: string[];
  created_at: Date;
  updated_at: Date;
}

export interface TenantSettings {
  tenantId: string;
  webhookNotifierUrl: string | null;
  recipientEmails: string[];
  createdAt: string;
  updatedAt: string;
}

function mapTenantSettings(row: TenantSettingsRow): TenantSettings {
  return {
    tenantId: row.tenant_id,
    webhookNotifierUrl: row.webhook_notifier_url,
    recipientEmails: row.recipient_emails ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class SettingsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getByTenantId(tenantId: string): Promise<TenantSettings | null> {
    const result = await this.databaseService.query<TenantSettingsRow>('SELECT * FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
    const row = result.rows[0];
    return row ? mapTenantSettings(row) : null;
  }

  async upsertNotifierSettings(input: {
    tenantId: string;
    webhookNotifierUrl: string | null;
    recipientEmails: string[];
  }): Promise<TenantSettings> {
    const result = await this.databaseService.query<TenantSettingsRow>(
      `
        INSERT INTO tenant_settings (tenant_id, webhook_notifier_url, recipient_emails)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id)
        DO UPDATE SET webhook_notifier_url = EXCLUDED.webhook_notifier_url,
                      recipient_emails = EXCLUDED.recipient_emails,
                      updated_at = NOW()
        RETURNING *
      `,
      [input.tenantId, input.webhookNotifierUrl, input.recipientEmails],
    );

    return mapTenantSettings(result.rows[0]);
  }
}
