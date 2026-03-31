import { Transform } from 'class-transformer';
import { IsOptional, IsUrl } from 'class-validator';

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

export class UpdateSettingsDto {
  @Transform(({ value }) => normalizeOptionalUrl(value))
  @IsOptional()
  @IsUrl({ require_tld: true, require_protocol: true })
  webhook_notifier_url?: string | null;
}
