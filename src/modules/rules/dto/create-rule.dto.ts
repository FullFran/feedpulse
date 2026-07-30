import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Longest phrase a single rule keyword may carry.
 *
 * A keyword is not inert text: `keyword-match.ts` compiles it into a regex and
 * `EntriesRepository` puts it inside `normalized_search_document ILIKE '%...%'`,
 * which is already a sequential scan. Left unbounded, one request can store a
 * megabyte-long phrase that every subsequent ingestion run pays for.
 *
 * The cap is deliberately generous — far longer than any real headline phrase —
 * because it is enforced on write only, and rules created before it existed have
 * to survive their next update.
 */
export const RULE_KEYWORD_MAX_LENGTH = 200;

/** Longest rule name. Migration 0020 renames duplicates against the same budget. */
export const RULE_NAME_MAX_LENGTH = 120;

/**
 * Trimmed before validation so that `AI updates` and `AI updates ` cannot become two rules that
 * look identical to an operator but are distinct to `idx_rules_tenant_name_unique`.
 */
export function normalizeRuleName(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

export class CreateRuleDto {
  @ApiProperty({ example: 'Grid outages', maxLength: RULE_NAME_MAX_LENGTH })
  @Transform(({ value }) => normalizeRuleName(value))
  @IsString()
  @MaxLength(RULE_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    type: [String],
    example: ['power outage', 'São Paulo'],
    description:
      'Each item is matched as a full normalized phrase (accent-insensitive, contiguous text). Max 20 items, 200 characters each.',
    maxItems: 20,
  })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsArray()
  @ArrayNotEmpty({ message: 'rule_missing_include_keywords' })
  @ArrayMaxSize(20)
  @MaxLength(RULE_KEYWORD_MAX_LENGTH, { each: true, message: 'rule_keyword_too_long' })
  include_keywords!: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['scheduled maintenance'],
    description: 'Blocks alerts when a full normalized phrase is present. Max 20 items, 200 characters each.',
    maxItems: 20,
  })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @MaxLength(RULE_KEYWORD_MAX_LENGTH, { each: true, message: 'rule_keyword_too_long' })
  exclude_keywords?: string[];

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
