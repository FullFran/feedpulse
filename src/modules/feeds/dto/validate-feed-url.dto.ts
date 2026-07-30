import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * Longest URL accepted for validation. Well above anything a real feed uses and
 * far below what would let a client push a multi-megabyte string through the
 * validator, the logger and the outbound request line.
 */
export const VALIDATE_FEED_URL_MAX_LENGTH = 2048;

export class ValidateFeedUrlDto {
  @ApiProperty({
    example: 'https://example.com/rss.xml',
    maxLength: VALIDATE_FEED_URL_MAX_LENGTH,
    description: 'Absolute http(s) URL to probe. It does not have to be registered as a feed.',
  })
  @IsString({ message: 'feed_invalid_url' })
  @MaxLength(VALIDATE_FEED_URL_MAX_LENGTH, { message: 'feed_invalid_url' })
  // `require_protocol` keeps `example.com/rss.xml` out: without a scheme the URL
  // parser in `assertSafePublicUrl` would reject it later anyway, and rejecting
  // it here produces the standard 400 envelope instead of an `unsafe_protocol`
  // result that looks like an upstream problem.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] }, { message: 'feed_invalid_url' })
  url!: string;
}

export class ValidateFeedUrlSampleItemModel {
  @ApiProperty({ type: String, nullable: true, example: 'Council approves the new housing plan' })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'https://example.com/articles/housing-plan' })
  link!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-29T09:12:00.000Z' })
  publishedAt!: string | null;
}

export class ValidateFeedUrlResultModel {
  @ApiProperty({
    example: true,
    description: 'True when the origin answered with a status below 400 after following redirects.',
  })
  reachable!: boolean;

  @ApiProperty({ type: Number, nullable: true, example: 200 })
  statusCode!: number | null;

  @ApiProperty({ example: 184, description: 'Round-trip time of the probe in milliseconds.' })
  latencyMs!: number;

  @ApiProperty({ type: String, nullable: true, example: 'Example City Newsroom' })
  feedTitle!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 42, description: 'Items found in the parsed feed.' })
  itemCount!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-29T09:12:00.000Z' })
  latestItemPublishedAt!: string | null;

  @ApiProperty({
    type: () => ValidateFeedUrlSampleItemModel,
    isArray: true,
    description: 'Up to three of the most recent items, so the caller sees what would be matched.',
  })
  sampleItems!: ValidateFeedUrlSampleItemModel[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Closed error vocabulary. `null` means the URL was fetched and parsed as a feed. Upstream error text is never echoed.',
    enum: [
      'dns_failure',
      'connection_refused',
      'tls_error',
      'timeout',
      'unsafe_protocol',
      'unsafe_host',
      'too_many_redirects',
      'invalid_redirect',
      'response_too_large',
      'parse_error',
      'http_4xx / http_5xx',
      'unknown',
    ],
  })
  error!: string | null;
}
