import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { normalizeRuleName, RULE_KEYWORD_MAX_LENGTH, RULE_NAME_MAX_LENGTH } from './create-rule.dto';

function normalizeKeywords(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

export class UpdateRuleDto {
  @ApiPropertyOptional({ example: 'Platform milestones', maxLength: RULE_NAME_MAX_LENGTH })
  @Transform(({ value }) => normalizeRuleName(value))
  @IsOptional()
  @IsString()
  @MaxLength(RULE_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['power outage', 'São Paulo'],
    description:
      'Each item is matched as a full normalized phrase (accent-insensitive, contiguous text). Max 20 items, 200 characters each.',
    maxItems: 20,
  })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'rule_missing_include_keywords' })
  @ArrayMaxSize(20)
  @MaxLength(RULE_KEYWORD_MAX_LENGTH, { each: true, message: 'rule_keyword_too_long' })
  include_keywords?: string[];

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

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
