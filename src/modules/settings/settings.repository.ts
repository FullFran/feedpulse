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
  telegram_bot_token_key_version: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenantEncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  /**
   * Which master-key derivation produced this ciphertext. See
   * `src/modules/settings/tenant-secrets.service.ts` for the vocabulary; 1 is
   * the pre-0021 legacy scheme and is what a row without the column decodes to.
   */
  keyVersion: number;
}

/**
 * Placeholder written into `telegram_bot_token_key_version` for rows that carry
 * no ciphertext. The column is `NOT NULL DEFAULT 1` in the schema and is only
 * ever read when `telegram_bot_token_ciphertext IS NOT NULL`, so the value is
 * inert; it is named rather than inlined so it is not mistaken for a decision
 * about how new secrets are encrypted.
 */
const KEY_VERSION_WHEN_NO_CIPHERTEXT = 1;

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
    // A row selected from a schema that predates 0021 has no column at all;
    // that is exactly the legacy scheme, so default rather than fail.
    keyVersion: row.telegram_bot_token_key_version ?? KEY_VERSION_WHEN_NO_CIPHERTEXT,
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

/**
 * Tenant isolation note: `tenant_settings.tenant_id` is the table's PRIMARY KEY, so every
 * method here is keyed by tenant by construction and there is no unscoped read or write to
 * add a guard to. Any future method must keep taking a REQUIRED `tenantId` — the rows hold
 * webhook URLs, recipient e-mail addresses and encrypted Telegram bot tokens, which is the
 * most damaging thing in the schema to leak across tenants.
 */
@Injectable()
export class SettingsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getByTenantId(tenantId: string): Promise<TenantSettings | null> {
    const result = await this.databaseService.query<TenantSettingsRow>(
      'SELECT * FROM tenant_settings WHERE tenant_id = $1',
      [tenantId],
    );
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
          telegram_bot_token_tag,
          telegram_bot_token_key_version
        )
        VALUES ($1, $2, $3, $4, $5, $7, $8, $9, $10)
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
                      telegram_bot_token_key_version = CASE
                        WHEN $6 = 'set' THEN EXCLUDED.telegram_bot_token_key_version
                        ELSE tenant_settings.telegram_bot_token_key_version
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
        input.telegramBotTokenEncrypted?.keyVersion ?? KEY_VERSION_WHEN_NO_CIPHERTEXT,
      ],
    );

    const row = result.rows[0];

    if (!row) {
      // `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` always yields exactly
      // one row. The guard is here so the impossible case fails loudly instead
      // of dereferencing `undefined` inside `mapTenantSettings`.
      throw new Error('tenant_settings_upsert_returned_no_row');
    }

    return mapTenantSettings(row);
  }

  /**
   * Rewrites a stored Telegram bot token under a newer key version, in place.
   *
   * This is a storage-format migration, not a settings change, so it
   * deliberately leaves `updated_at` alone: an operator looking at the settings
   * page should not see a phantom edit they did not make.
   *
   * The WHERE clause pins the exact ciphertext and version it read, so a
   * concurrent `upsertNotifierSettings` that set a brand-new token wins and this
   * update becomes a no-op instead of resurrecting the old secret. Returns
   * whether the row was actually rewritten.
   */
  async upgradeTelegramBotTokenKeyVersion(input: {
    tenantId: string;
    expected: TenantEncryptedSecret;
    encrypted: TenantEncryptedSecret;
  }): Promise<boolean> {
    const result = await this.databaseService.query(
      `
        UPDATE tenant_settings
           SET telegram_bot_token_ciphertext = $2,
               telegram_bot_token_iv = $3,
               telegram_bot_token_tag = $4,
               telegram_bot_token_key_version = $5
         WHERE tenant_id = $1
           AND telegram_bot_token_ciphertext = $6
           AND telegram_bot_token_key_version = $7
      `,
      [
        input.tenantId,
        input.encrypted.ciphertext,
        input.encrypted.iv,
        input.encrypted.tag,
        input.encrypted.keyVersion,
        input.expected.ciphertext,
        input.expected.keyVersion,
      ],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
