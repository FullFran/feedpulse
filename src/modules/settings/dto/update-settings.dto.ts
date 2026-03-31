import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUrl, Matches } from 'class-validator';

import { TELEGRAM_DELIVERY_MODES, TelegramDeliveryMode } from '../settings.types';

function normalizeOptionalUrl(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseRecipientEmails(value: unknown): unknown {
  if (value === null) {
    return [];
  }

  if (value === undefined) {
    return undefined;
  }

  const tokens = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\n,]/g)
          .map((part) => part.trim())
          .filter(Boolean)
      : value;

  if (!Array.isArray(tokens)) {
    return tokens;
  }

  return Array.from(new Set(tokens.map((email) => String(email).trim().toLowerCase()).filter(Boolean)));
}

function parseTelegramChatIds(value: unknown): unknown {
  if (value === null) {
    return [];
  }

  if (value === undefined) {
    return undefined;
  }

  const tokens = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\n,]/g)
          .map((part) => part.trim())
          .filter(Boolean)
      : value;

  if (!Array.isArray(tokens)) {
    return tokens;
  }

  return Array.from(
    new Set(
      tokens
        .map((chatId) => String(chatId).trim())
        .filter(Boolean)
        .filter((chatId) => /^-?\d+$/.test(chatId)),
    ),
  );
}

function normalizeDeliveryMode(value: unknown): TelegramDeliveryMode | unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  return value.trim().toLowerCase();
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeBoolean(value: unknown): boolean | unknown {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  return value;
}

export class UpdateSettingsDto {
  @Transform(({ value }) => normalizeOptionalUrl(value))
  @IsOptional()
  @IsUrl({ require_tld: true, require_protocol: true })
  webhook_notifier_url?: string | null;

  @Transform(({ value }) => parseRecipientEmails(value))
  @IsOptional()
  @IsArray()
  @IsEmail({}, { each: true })
  recipient_emails?: string[];

  @Transform(({ value }) => parseTelegramChatIds(value))
  @IsOptional()
  @IsArray()
  @Matches(/^-?\d+$/, { each: true })
  telegram_chat_ids?: string[];

  @Transform(({ value }) => normalizeDeliveryMode(value))
  @IsOptional()
  @IsIn(TELEGRAM_DELIVERY_MODES)
  telegram_delivery_mode?: TelegramDeliveryMode;

  @Transform(({ value }) => normalizeOptionalString(value))
  @IsOptional()
  @IsString()
  telegram_bot_token?: string | null;

  @Transform(({ value }) => normalizeBoolean(value))
  @IsOptional()
  @IsBoolean()
  telegram_bot_token_clear?: boolean;
}
