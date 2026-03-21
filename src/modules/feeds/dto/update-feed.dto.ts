import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFeedDto {
  @ApiPropertyOptional({ minimum: 300, maximum: 10800, example: 600 })
  @IsOptional()
  @IsInt({ message: 'feed_invalid_poll_interval' })
  @Min(300, { message: 'feed_invalid_poll_interval' })
  @Max(10800, { message: 'feed_invalid_poll_interval' })
  poll_interval_seconds?: number;

  @ApiPropertyOptional({ enum: ['active', 'paused', 'error'], example: 'paused' })
  @IsOptional()
  @IsIn(['active', 'paused', 'error'], { message: 'feed_invalid_status' })
  status?: 'active' | 'paused' | 'error';
}
