import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class OpmlPreviewQueryDto {
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
