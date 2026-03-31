import { Transform } from 'class-transformer';
import { IsArray, IsEmail, IsOptional, IsUrl } from 'class-validator';

function normalizeOptionalUrl(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return value as undefined;
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
}
