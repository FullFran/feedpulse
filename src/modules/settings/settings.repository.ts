import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { DEFAULT_TELEGRAM_DELIVERY_MODE, TelegramDeliveryMode } from './settings.types';

interface TenantSettingsRow {
  tenant_id: string;
  webhook_notifier_url: string | null;
  recipient_emails: string[];
  telegram_chat_ids: string[];
  telegram_delivery_mode: TelegramDeliveryMode;
  telegram_bot_token_ciphertext: string | null;
  telegram_bot_token_iv: string | null;
  telegram_bot_token_tag: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenantEncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export type TenantTelegramBotTokenOperation = 'unchanged' | 'clear' | 'set';

export interface TenantSettings {
  tenantId: string;
  webhookNotifierUrl: string | null;
  recipientEmails: string[];
  telegramChatIds: string[];
  telegramDeliveryMode: TelegramDeliveryMode;
  telegramBotTokenConfigured: boolean;
  telegramBotTokenEncrypted: TenantEncryptedSecret | null;
  createdAt: string;
  updatedAt: string;
}

function mapTelegramBotTokenEncrypted(row: TenantSettingsRow): TenantEncryptedSecret | null {
  if (!row.telegram_bot_token_ciphertext || !row.telegram_bot_token_iv || !row.telegram_bot_token_tag) {
    return null;
  }

  return {
    ciphertext: row.telegram_bot_token_ciphertext,
    iv: row.telegram_bot_token_iv,
    tag: row.telegram_bot_token_tag,
  };
}

function mapTenantSettings(row: TenantSettingsRow): TenantSettings {
  const telegramBotTokenEncrypted = mapTelegramBotTokenEncrypted(row);

  return {
    tenantId: row.tenant_id,
    webhookNotifierUrl: row.webhook_notifier_url,
    recipientEmails: row.recipient_emails ?? [],
    telegramChatIds: row.telegram_chat_ids ?? [],
    telegramDeliveryMode: row.telegram_delivery_mode ?? DEFAULT_TELEGRAM_DELIVERY_MODE,
    telegramBotTokenConfigured: Boolean(telegramBotTokenEncrypted),
    telegramBotTokenEncrypted,
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
    telegramChatIds: string[];
    telegramDeliveryMode: TelegramDeliveryMode;
    telegramBotTokenOperation: TenantTelegramBotTokenOperation;
    telegramBotTokenEncrypted: TenantEncryptedSecret | null;
  }): Promise<TenantSettings> {
    const result = await this.databaseService.query<TenantSettingsRow>(
      `
        INSERT INTO tenant_settings (
          tenant_id,
          webhook_notifier_url,
          recipient_emails,
          telegram_chat_ids,
          telegram_delivery_mode,
          telegram_bot_token_ciphertext,
          telegram_bot_token_iv,
          telegram_bot_token_tag
        )
        VALUES ($1, $2, $3, $4, $5, $7, $8, $9)
        ON CONFLICT (tenant_id)
        DO UPDATE SET webhook_notifier_url = EXCLUDED.webhook_notifier_url,
                      recipient_emails = EXCLUDED.recipient_emails,
                      telegram_chat_ids = EXCLUDED.telegram_chat_ids,
                      telegram_delivery_mode = EXCLUDED.telegram_delivery_mode,
                      telegram_bot_token_ciphertext = CASE
                        WHEN $6 = 'set' THEN EXCLUDED.telegram_bot_token_ciphertext
                        WHEN $6 = 'clear' THEN NULL
                        ELSE tenant_settings.telegram_bot_token_ciphertext
                      END,
                      telegram_bot_token_iv = CASE
                        WHEN $6 = 'set' THEN EXCLUDED.telegram_bot_token_iv
                        WHEN $6 = 'clear' THEN NULL
                        ELSE tenant_settings.telegram_bot_token_iv
                      END,
                      telegram_bot_token_tag = CASE
                        WHEN $6 = 'set' THEN EXCLUDED.telegram_bot_token_tag
                        WHEN $6 = 'clear' THEN NULL
                        ELSE tenant_settings.telegram_bot_token_tag
                      END,
                      updated_at = NOW()
        RETURNING *
      `,
      [
        input.tenantId,
        input.webhookNotifierUrl,
        input.recipientEmails,
        input.telegramChatIds,
        input.telegramDeliveryMode,
        input.telegramBotTokenOperation,
        input.telegramBotTokenEncrypted?.ciphertext ?? null,
        input.telegramBotTokenEncrypted?.iv ?? null,
        input.telegramBotTokenEncrypted?.tag ?? null,
      ],
    );

    return mapTenantSettings(result.rows[0]);
  }
}
