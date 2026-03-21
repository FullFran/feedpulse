import { IsIn, IsInt, IsOptional, IsUrl, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFeedDto {
  @ApiProperty({ example: 'https://example.com/rss.xml' })
  @IsUrl({ require_tld: false }, { message: 'feed_invalid_url' })
  url!: string;

  @ApiPropertyOptional({ minimum: 300, maximum: 10800, example: 1800 })
  @IsOptional()
  @IsInt({ message: 'feed_invalid_poll_interval' })
  @Min(300, { message: 'feed_invalid_poll_interval' })
  @Max(10800, { message: 'feed_invalid_poll_interval' })
  poll_interval_seconds?: number;

  @ApiPropertyOptional({ enum: ['active', 'paused', 'error'], example: 'active' })
  @IsOptional()
  @IsIn(['active', 'paused', 'error'])
  status?: 'active' | 'paused' | 'error';
}
