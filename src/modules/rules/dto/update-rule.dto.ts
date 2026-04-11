import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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
  @ApiPropertyOptional({ example: 'Platform milestones' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['ocupación de una vivienda'],
    description: 'Each item is matched as a full normalized phrase (accent-insensitive, contiguous text).',
  })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'rule_missing_include_keywords' })
  @ArrayMaxSize(20)
  include_keywords?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['ocupación de una promoción'],
    description: 'Blocks alerts when a full normalized phrase is present.',
  })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  exclude_keywords?: string[];

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
