import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item).trim()).filter(Boolean);
}

export class CreateRuleDto {
  @ApiProperty({ example: 'AI updates' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: [String], example: ['AI', 'LLM'] })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsArray()
  @ArrayNotEmpty({ message: 'rule_missing_include_keywords' })
  @ArrayMaxSize(20)
  include_keywords!: string[];

  @ApiPropertyOptional({ type: [String], example: ['crypto'] })
  @Transform(({ value }) => normalizeKeywords(value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  exclude_keywords?: string[];

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
