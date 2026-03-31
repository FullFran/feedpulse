import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiMetaModel {
  @ApiProperty({ example: '2026-03-21T12:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 'a7b3d7f0-5f78-4cba-8f4d-cf2c92ad2f76' })
  request_id!: string;
}

export class PaginatedMetaModel extends ApiMetaModel {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  page_size!: number;

  @ApiProperty({ example: 125 })
  total!: number;

  @ApiProperty({ example: true })
  has_next!: boolean;
}

export class ErrorBodyModel {
  @ApiProperty({ example: 'feed_invalid_url' })
  code!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { field: 'url' },
  })
  details?: Record<string, unknown>;
}

export class ErrorEnvelopeModel {
  @ApiProperty({ type: () => ErrorBodyModel })
  error!: ErrorBodyModel;

  @ApiProperty({ type: () => ApiMetaModel })
  meta!: ApiMetaModel;
}

export class FeedModel {
  @ApiProperty({ example: 101 })
  id!: number;

  @ApiProperty({ example: 'https://example.com/rss.xml' })
  url!: string;

  @ApiProperty({ enum: ['active', 'paused', 'error'], example: 'active' })
  status!: 'active' | 'paused' | 'error';

  @ApiPropertyOptional({ type: String, nullable: true, example: 'etag-1' })
  etag!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'Fri, 20 Mar 2026 10:00:00 GMT' })
  lastModified!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-03-21T12:00:00.000Z' })
  lastCheckedAt!: string | null;

  @ApiProperty({ example: '2026-03-21T12:05:00.000Z' })
  nextCheckAt!: string;

  @ApiProperty({ example: 1800 })
  pollIntervalSeconds!: number;

  @ApiProperty({ example: 0 })
  errorCount!: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: null })
  lastError!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 245 })
  avgResponseMs!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 12.4 })
  avgItemsPerDay!: number | null;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  updatedAt!: string;
}

export class FeedCheckNowResultModel {
  @ApiProperty({ example: 101 })
  id!: number;

  @ApiProperty({ enum: ['queued'], example: 'queued' })
  status!: 'queued';
}

export class RuleModel {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ example: 'AI updates' })
  name!: string;

  @ApiProperty({ type: [String], example: ['AI', 'LLM'] })
  includeKeywords!: string[];

  @ApiProperty({ type: [String], example: ['crypto'] })
  excludeKeywords!: string[];

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  updatedAt!: string;
}

export class EntryModel {
  @ApiProperty({ example: '42' })
  id!: string;

  @ApiProperty({ example: 101 })
  feedId!: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'AI launch update' })
  title!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://example.com/items/1' })
  link!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'item-1' })
  guid!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'LLM systems reached a new milestone.' })
  content!: string | null;

  @ApiProperty({ example: 'd41d8cd98f00b204e9800998ecf8427e' })
  contentHash!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-03-21T10:55:00.000Z' })
  publishedAt!: string | null;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  fetchedAt!: string;
}

export class AlertEntryModel {
  @ApiProperty({ example: '42' })
  id!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'AI launch update' })
  title!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://example.com/items/1' })
  link!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'LLM systems reached a new milestone.' })
  content!: string | null;
}

export class AlertRuleModel {
  @ApiProperty({ example: 7 })
  id!: number;

  @ApiProperty({ example: 'AI updates' })
  name!: string;

  @ApiProperty({ type: [String], example: ['AI', 'LLM'] })
  includeKeywords!: string[];

  @ApiProperty({ type: [String], example: ['crypto'] })
  excludeKeywords!: string[];
}

export class AlertModel {
  @ApiProperty({ example: '55' })
  id!: string;

  @ApiProperty({ example: true })
  sent!: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-03-21T11:01:00.000Z' })
  sentAt!: string | null;

  @ApiProperty({ enum: ['pending', 'queued', 'retrying', 'sent', 'failed', 'disabled'], example: 'retrying' })
  deliveryStatus!: 'pending' | 'queued' | 'retrying' | 'sent' | 'failed' | 'disabled';

  @ApiProperty({ example: 2 })
  deliveryAttempts!: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-03-21T11:01:00.000Z' })
  lastDeliveryAttemptAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'webhook_delivery_failed_500' })
  lastDeliveryError!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-03-21T11:00:45.000Z' })
  lastDeliveryQueuedAt!: string | null;

  @ApiProperty({ example: '2026-03-21T11:00:30.000Z' })
  createdAt!: string;

  @ApiProperty({ type: () => AlertEntryModel })
  entry!: AlertEntryModel;

  @ApiProperty({ type: () => AlertRuleModel })
  rule!: AlertRuleModel;
}

export class AlertDeliveryResultModel {
  @ApiProperty({ example: '55' })
  id!: string;

  @ApiProperty({ enum: ['queued', 'already_sent', 'disabled'], example: 'queued' })
  status!: 'queued' | 'already_sent' | 'disabled';
}

export class TenantSettingsModel {
  @ApiPropertyOptional({ type: String, nullable: true, example: 'https://hooks.example.com/rss-alerts' })
  webhookNotifierUrl!: string | null;

  @ApiProperty({ type: [String], example: ['alerts@example.com', 'ops@example.com'] })
  recipientEmails!: string[];

  @ApiProperty({ type: [String], example: ['-1001234567890', '987654321'] })
  telegramChatIds!: string[];

  @ApiProperty({ enum: ['instant', 'digest_10m'], example: 'instant' })
  telegramDeliveryMode!: 'instant' | 'digest_10m';
}

export class HealthCheckStatusModel {
  @ApiProperty({ example: 'ok' })
  api!: string;
}

export class ReadinessChecksModel {
  @ApiProperty({ example: 'ok' })
  postgres!: string;

  @ApiProperty({ example: 'ok' })
  redis!: string;

  @ApiProperty({ example: 'ok' })
  schema!: string;
}

export class HealthResponseModel {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ type: () => HealthCheckStatusModel })
  checks!: HealthCheckStatusModel;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  timestamp!: string;
}

export class ReadinessResponseModel {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ type: () => ReadinessChecksModel })
  checks!: ReadinessChecksModel;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  timestamp!: string;
}

export class ReadinessFailureResponseModel {
  @ApiProperty({ example: 'error' })
  status!: string;

  @ApiProperty({ type: () => ReadinessChecksModel })
  checks!: ReadinessChecksModel;

  @ApiProperty({ example: '2026-03-21T11:00:00.000Z' })
  timestamp!: string;
}
