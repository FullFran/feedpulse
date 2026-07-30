import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Longest free-text search term.
 *
 * `search` lands in `normalized_search_document ILIKE '%...%'`, which cannot use the GIN index
 * and therefore scans. An unbounded term lets one query carry an arbitrarily long pattern into
 * that scan; the same 200-character budget the rule keywords use applies here.
 */
export const ENTRY_SEARCH_MAX_LENGTH = 200;

export class ListEntriesQueryDto {
  @ApiPropertyOptional({ example: 101 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  feed_id?: number;

  @ApiPropertyOptional({ example: 'milestone', maxLength: ENTRY_SEARCH_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(ENTRY_SEARCH_MAX_LENGTH, { message: 'entry_search_too_long' })
  search?: string;

  @ApiPropertyOptional({
    example: '2026-03-01T00:00:00.000Z',
    description: 'Filter entries with published_at or fetched_at >= from.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-03-31T23:59:59.999Z',
    description: 'Filter entries with published_at or fetched_at <= to.',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, default: 1 })
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 200, default: 50 })
  @Transform(({ value }) => Number(value ?? 50))
  @IsInt()
  @Min(1)
  @Max(200)
  page_size = 50;
}
