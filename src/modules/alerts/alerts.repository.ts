import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { canonicalizeArticleLink } from './domain/canonical-article-link';

type QueryExecutor = Pick<DatabaseService, 'query'>;

export interface AlertView {
  id: string;
  sent: boolean;
  sentAt: string | null;
  deliveryStatus: 'pending' | 'queued' | 'retrying' | 'sent' | 'failed' | 'disabled';
  deliveryAttempts: number;
  lastDeliveryAttemptAt: string | null;
  lastDeliveryError: string | null;
  lastDeliveryQueuedAt: string | null;
  createdAt: string;
  matchedRules: number[];
  webhookDeliveryStatus: 'pending' | 'sent' | 'failed';
  telegramDeliveryStatus: 'pending' | 'sent' | 'failed';
  emailDeliveryStatus: 'pending' | 'sent' | 'failed';
  entry: {
    id: string;
    title: string | null;
    link: string | null;
  };
  rule: {
    id: number;
    name: string;
  };
}

interface AlertRow {
  id: string;
  tenant_id: string;
  sent: boolean;
  sent_at: Date | null;
  delivery_status: 'pending' | 'queued' | 'retrying' | 'sent' | 'failed' | 'disabled';
  delivery_attempts: number;
  last_delivery_attempt_at: Date | null;
  last_delivery_error: string | null;
  last_delivery_queued_at: Date | null;
  created_at: Date;
  entry_id: string;
  entry_title: string | null;
  entry_link: string | null;
  entry_content: string | null;
  matched_rules: number[];
  webhook_delivery_status: 'pending' | 'sent' | 'failed';
  telegram_delivery_status: 'pending' | 'sent' | 'failed';
  email_delivery_status: 'pending' | 'sent' | 'failed';
  rule_id: number;
  rule_name: string;
  rule_include_keywords: string[];
  rule_exclude_keywords: string[];
}

interface TelegramDigestPendingGroupRow {
  tenant_id: string;
  chat_id: string;
}

interface TelegramDigestItemRow {
  digest_item_id: string;
  tenant_id: string;
  chat_id: string;
  scheduled_for: Date;
  alert_id: string;
  alert_created_at: Date;
  entry_title: string | null;
  entry_link: string | null;
  entry_content: string | null;
}

export interface CreatedAlert {
  id: string;
  entryId: string;
  ruleId: number;
}

export interface AlertChannelDeliveryStatus {
  webhook: 'pending' | 'sent' | 'failed';
  telegram: 'pending' | 'sent' | 'failed';
  email: 'pending' | 'sent' | 'failed';
}

export interface AlertNotificationRecord {
  id: string;
  tenantId: string;
  sent: boolean;
  sentAt: string | null;
  deliveryStatus: 'pending' | 'queued' | 'retrying' | 'sent' | 'failed' | 'disabled';
  deliveryAttempts: number;
  lastDeliveryAttemptAt: string | null;
  lastDeliveryError: string | null;
  lastDeliveryQueuedAt: string | null;
  createdAt: string;
  matchedRules: number[];
  webhookDeliveryStatus: 'pending' | 'sent' | 'failed';
  telegramDeliveryStatus: 'pending' | 'sent' | 'failed';
  emailDeliveryStatus: 'pending' | 'sent' | 'failed';
  entry: {
    id: string;
    title: string | null;
    link: string | null;
    content: string | null;
  };
  rule: {
    id: number;
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
  };
}

export interface TelegramDigestGroup {
  tenantId: string;
  chatId: string;
  scheduledFor: string;
  items: Array<{
    digestItemId: number;
    alertId: string;
    createdAt: string;
    title: string | null;
    link: string | null;
    snippet: string | null;
  }>;
}

function computeNextDigestWindow(now = new Date()): string {
  const digestWindowMs = 10 * 60 * 1000;
  const nextWindow = new Date(Math.ceil(now.getTime() / digestWindowMs) * digestWindowMs);
  return nextWindow.toISOString();
}

function mapAlert(row: AlertRow): AlertNotificationRecord {
  // For backward compatibility - get first rule if matched_rules not present
  const matchedRules = row.matched_rules && row.matched_rules.length > 0 ? row.matched_rules : [row.rule_id];

  return {
    id: row.id,
    tenantId: row.tenant_id,
    sent: row.sent,
    sentAt: row.sent_at?.toISOString() ?? null,
    deliveryStatus: row.delivery_status,
    deliveryAttempts: row.delivery_attempts,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at?.toISOString() ?? null,
    lastDeliveryError: row.last_delivery_error,
    lastDeliveryQueuedAt: row.last_delivery_queued_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    matchedRules: matchedRules,
    webhookDeliveryStatus: row.webhook_delivery_status,
    telegramDeliveryStatus: row.telegram_delivery_status,
    emailDeliveryStatus: row.email_delivery_status,
    entry: {
      id: row.entry_id,
      title: row.entry_title,
      link: row.entry_link,
      content: row.entry_content,
    },
    rule: {
      id: row.rule_id,
      name: row.rule_name,
      includeKeywords: row.rule_include_keywords,
      excludeKeywords: row.rule_exclude_keywords,
    },
  };
}

@Injectable()
export class AlertsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createForMatches(matches: Array<{ entryId: string; ruleId: number }>, executor: QueryExecutor = this.databaseService): Promise<CreatedAlert[]> {
    const created: CreatedAlert[] = [];

    for (const match of matches) {
      const entryResult = await executor.query<{ tenant_id: string; link: string | null }>(
        `
          SELECT tenant_id, link
          FROM entries
          WHERE id = $1::bigint
        `,
        [match.entryId],
      );

      const entry = entryResult.rows[0];
      if (!entry) {
        continue;
      }

      const canonicalLink = canonicalizeArticleLink(entry.link);

      const result = await executor.query<{ id: string }>(
        `
          INSERT INTO alerts (tenant_id, entry_id, rule_id, canonical_link)
          VALUES ($1::text, $2::bigint, $3::int, $4::text)
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [entry.tenant_id, match.entryId, match.ruleId, canonicalLink],
      );

      if (result.rows[0]) {
        created.push({
          id: result.rows[0].id,
          entryId: match.entryId,
          ruleId: match.ruleId,
        });
      }
    }

    return created;
  }

  /**
   * Create alerts with aggregated matching rules (ONE alert per article).
   * This replaces the one-alert-per-rule behavior.
   * @param matchesByEntry Map of entryId -> array of matching rule IDs
   */
  async createForEntryWithRules(
    matchesByEntry: Map<string, number[]>,
    executor: QueryExecutor = this.databaseService,
  ): Promise<CreatedAlert[]> {
    const created: CreatedAlert[] = [];

    for (const [entryId, ruleIds] of matchesByEntry) {
      const entryResult = await executor.query<{ tenant_id: string; link: string | null }>(
        `
          SELECT tenant_id, link
          FROM entries
          WHERE id = $1::bigint
        `,
        [entryId],
      );

      const entry = entryResult.rows[0];
      if (!entry || ruleIds.length === 0) {
        continue;
      }

      const canonicalLink = canonicalizeArticleLink(entry.link);

      // First, try to find existing alert for this canonical link
      const existingResult = await executor.query<{ id: string; matched_rules: number[] }>(
        `
          SELECT id, matched_rules
          FROM alerts
          WHERE tenant_id = $1 AND canonical_link = $2
        `,
        [entry.tenant_id, canonicalLink],
      );

      if (existingResult.rows[0]) {
        // Update with additional rules
        const existingRules = existingResult.rows[0].matched_rules || [];
        const combinedRules = [...new Set([...existingRules, ...ruleIds])];

        await executor.query(
          `
            UPDATE alerts
            SET matched_rules = $2::int[]
            WHERE id = $1
          `,
          [existingResult.rows[0].id, combinedRules],
        );

        created.push({
          id: existingResult.rows[0].id,
          entryId: entryId,
          ruleId: ruleIds[0],
        });
      } else {
        // Insert new alert
        const result = await executor.query<{ id: string }>(
          `
            INSERT INTO alerts (tenant_id, entry_id, rule_id, matched_rules, canonical_link)
            VALUES ($1::text, $2::bigint, $3::int, $4::int[], $5::text)
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [entry.tenant_id, entryId, ruleIds[0], ruleIds, canonicalLink],
        );

        if (result.rows[0]) {
          created.push({
            id: result.rows[0].id,
            entryId: entryId,
            ruleId: ruleIds[0],
          });
        }
      }
    }

    return created;
  }

  async list(input: { tenantId: string; page: number; pageSize: number; sent?: boolean }): Promise<{ items: AlertView[]; total: number }> {
    const where: string[] = ['a.tenant_id = $1'];
    const values: unknown[] = [input.tenantId];

    if (typeof input.sent === 'boolean') {
      where.push(`a.sent = $${values.length + 1}`);
      values.push(input.sent);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;

    // Use COALESCE to get first rule from matched_rules array for backward compatibility
    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<AlertRow>(
        `
          SELECT a.id,
                 a.tenant_id,
                 a.sent,
                 a.sent_at,
                 a.delivery_status,
                 a.delivery_attempts,
                 a.last_delivery_attempt_at,
                 a.last_delivery_error,
                 a.last_delivery_queued_at,
                 a.created_at,
                 a.matched_rules,
                 a.webhook_delivery_status,
                 a.telegram_delivery_status,
                 a.email_delivery_status,
                 e.id AS entry_id,
                 e.title AS entry_title,
                 e.link AS entry_link,
                 e.content AS entry_content,
                 COALESCE((a.matched_rules)[1], a.rule_id) AS rule_id,
                 r.name AS rule_name,
                 r.include_keywords AS rule_include_keywords,
                 r.exclude_keywords AS rule_exclude_keywords
          FROM alerts a
          INNER JOIN entries e ON e.id = a.entry_id
          INNER JOIN rules r ON r.id = COALESCE((a.matched_rules)[1], a.rule_id)
          ${clause}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, input.pageSize, offset],
      ),
      this.databaseService.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM alerts a ${clause}`, values),
    ]);

    return {
      items: itemsResult.rows.map((row) => {
        const { tenantId: _tenantId, ...alert } = mapAlert(row);
        return alert;
      }),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

async findById(id: number, tenantId?: string): Promise<AlertNotificationRecord | null> {
    const result = tenantId
      ? await this.databaseService.query<AlertRow>(
        `
          SELECT a.id,
                 a.tenant_id,
                 a.sent,
                 a.sent_at,
                 a.delivery_status,
                 a.delivery_attempts,
                 a.last_delivery_attempt_at,
                 a.last_delivery_error,
                 a.last_delivery_queued_at,
                 a.created_at,
                 a.matched_rules,
                 a.webhook_delivery_status,
                 a.telegram_delivery_status,
                 a.email_delivery_status,
                 e.id AS entry_id,
                 e.title AS entry_title,
                 e.link AS entry_link,
                 e.content AS entry_content,
                 COALESCE((a.matched_rules)[1], a.rule_id) AS rule_id,
                 r.name AS rule_name,
                 r.include_keywords AS rule_include_keywords,
                 r.exclude_keywords AS rule_exclude_keywords
          FROM alerts a
          INNER JOIN entries e ON e.id = a.entry_id
          INNER JOIN rules r ON r.id = COALESCE((a.matched_rules)[1], a.rule_id)
          WHERE a.id = $1
            AND a.tenant_id = $2
        `,
        [id, tenantId],
      )
      : await this.databaseService.query<AlertRow>(
        `
          SELECT a.id,
                 a.tenant_id,
                 a.sent,
                 a.sent_at,
                 a.delivery_status,
                 a.delivery_attempts,
                 a.last_delivery_attempt_at,
                 a.last_delivery_error,
                 a.last_delivery_queued_at,
                 a.created_at,
                 a.matched_rules,
                 a.webhook_delivery_status,
                 a.telegram_delivery_status,
                 a.email_delivery_status,
                 e.id AS entry_id,
                 e.title AS entry_title,
                 e.link AS entry_link,
                 e.content AS entry_content,
                 COALESCE((a.matched_rules)[1], a.rule_id) AS rule_id,
                 r.name AS rule_name,
                 r.include_keywords AS rule_include_keywords,
                 r.exclude_keywords AS rule_exclude_keywords
          FROM alerts a
          INNER JOIN entries e ON e.id = a.entry_id
          INNER JOIN rules r ON r.id = COALESCE((a.matched_rules)[1], a.rule_id)
          WHERE a.id = $1
        `,
        [id],
      );

    return result.rows[0] ? mapAlert(result.rows[0]) : null;
  }

  async markDeliveryQueued(id: number, executor: QueryExecutor = this.databaseService): Promise<void> {
    await executor.query(
      `
        UPDATE alerts
        SET delivery_status = CASE
              WHEN delivery_attempts > 0 THEN 'retrying'
              ELSE 'queued'
            END,
            last_delivery_queued_at = NOW()
        WHERE id = $1
      `,
      [id],
    );
  }

  async markDeliveryDisabled(id: number, executor: QueryExecutor = this.databaseService): Promise<void> {
    await executor.query(
      `
        UPDATE alerts
        SET delivery_status = 'disabled',
            last_delivery_error = 'notifier_disabled',
            last_delivery_attempt_at = NOW()
        WHERE id = $1
      `,
      [id],
    );
  }

  async markSent(id: number, attemptNumber: number, executor: QueryExecutor = this.databaseService): Promise<boolean> {
    const result = await executor.query(
      `
        UPDATE alerts
        SET sent = true,
            sent_at = COALESCE(sent_at, NOW()),
            delivery_status = 'sent',
            delivery_attempts = GREATEST(delivery_attempts, $2),
            last_delivery_attempt_at = NOW(),
            last_delivery_error = NULL
        WHERE id = $1
      `,
      [id, attemptNumber],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async markDeliveryFailure(
    id: number,
    input: { attemptNumber: number; error: string; willRetry: boolean },
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE alerts
        SET delivery_status = $2,
            delivery_attempts = GREATEST(delivery_attempts, $3),
            last_delivery_attempt_at = NOW(),
            last_delivery_error = $4
        WHERE id = $1
      `,
      [id, input.willRetry ? 'retrying' : 'failed', input.attemptNumber, input.error],
    );
  }

  /**
   * Mark a specific channel as delivered (sent).
   * This is used for per-channel delivery tracking.
   */
  async markChannelDelivered(id: number, channel: 'webhook' | 'telegram' | 'email', executor: QueryExecutor = this.databaseService): Promise<void> {
    const column = `${channel}_delivery_status`;
    await executor.query(
      `
        UPDATE alerts
        SET ${column} = 'sent',
            last_delivery_attempt_at = NOW()
        WHERE id = $1
      `,
      [id],
    );
  }

  /**
   * Check if all configured channels have been delivered.
   */
  async checkAllChannelsDelivered(
    id: number,
    config: { hasWebhook: boolean; hasEmail: boolean; hasTelegram: boolean },
  ): Promise<{ allDelivered: boolean }> {
    const result = await this.databaseService.query<{ all_delivered: boolean }>(
      `
        SELECT CASE
          WHEN ($2 = false OR webhook_delivery_status = 'sent')
           AND ($3 = false OR email_delivery_status = 'sent')
           AND ($4 = false OR telegram_delivery_status = 'sent')
          THEN true
          ELSE false
        END AS all_delivered
        FROM alerts
        WHERE id = $1
      `,
      [id, config.hasWebhook, config.hasEmail, config.hasTelegram],
    );
    return { allDelivered: result.rows[0]?.all_delivered ?? false };
  }

  /**
   * Mark delivery as retrying/pending (for partial delivery scenarios).
   */
  async markDeliveryRetryPending(id: number, attemptNumber: number, executor: QueryExecutor = this.databaseService): Promise<void> {
    await executor.query(
      `
        UPDATE alerts
        SET delivery_status = 'retrying',
            delivery_attempts = GREATEST(delivery_attempts, $2),
            last_delivery_attempt_at = NOW()
        WHERE id = $1
      `,
      [id, attemptNumber],
    );
  }

  async queueTelegramDigestItems(input: { alertId: number; tenantId: string; chatIds: string[] }): Promise<void> {
    if (!input.chatIds.length) {
      return;
    }

    const scheduledFor = computeNextDigestWindow();
    for (const chatId of input.chatIds) {
      await this.databaseService.query(
        `
          INSERT INTO telegram_digest_items (tenant_id, alert_id, chat_id, scheduled_for)
          VALUES ($1, $2, $3, $4::timestamptz)
          ON CONFLICT (alert_id, chat_id) DO NOTHING
        `,
        [input.tenantId, input.alertId, chatId, scheduledFor],
      );
    }
  }

  async listDueTelegramDigestGroups(input: { nowIso: string; maxGroups: number }): Promise<TelegramDigestGroup[]> {
    const groups = await this.databaseService.query<TelegramDigestPendingGroupRow>(
      `
        SELECT tenant_id, chat_id
        FROM telegram_digest_items
        WHERE sent_at IS NULL
          AND scheduled_for <= $1
        GROUP BY tenant_id, chat_id
        ORDER BY MIN(scheduled_for) ASC
        LIMIT $2
      `,
      [input.nowIso, input.maxGroups],
    );

    const result: TelegramDigestGroup[] = [];
    for (const group of groups.rows) {
      const itemsResult = await this.databaseService.query<TelegramDigestItemRow>(
        `
          SELECT tdi.id AS digest_item_id,
                 tdi.tenant_id,
                 tdi.chat_id,
                 tdi.scheduled_for,
                 a.id AS alert_id,
                 a.created_at AS alert_created_at,
                 e.title AS entry_title,
                 e.link AS entry_link,
                 e.content AS entry_content
          FROM telegram_digest_items tdi
          INNER JOIN alerts a ON a.id = tdi.alert_id
          INNER JOIN entries e ON e.id = a.entry_id
          WHERE tdi.tenant_id = $1
            AND tdi.chat_id = $2
            AND tdi.sent_at IS NULL
            AND tdi.scheduled_for <= $3
          ORDER BY tdi.created_at ASC, tdi.id ASC
        `,
        [group.tenant_id, group.chat_id, input.nowIso],
      );

      if (!itemsResult.rows.length) {
        continue;
      }

      result.push({
        tenantId: group.tenant_id,
        chatId: group.chat_id,
        scheduledFor: itemsResult.rows[0].scheduled_for.toISOString(),
        items: itemsResult.rows.map((row) => ({
          digestItemId: Number(row.digest_item_id),
          alertId: row.alert_id,
          createdAt: row.alert_created_at.toISOString(),
          title: row.entry_title,
          link: row.entry_link,
          snippet: row.entry_content,
        })),
      });
    }

    return result;
  }

  async markTelegramDigestItemsSent(itemIds: number[]): Promise<void> {
    if (!itemIds.length) {
      return;
    }

    for (const itemId of itemIds) {
      await this.databaseService.query(
        `
          UPDATE telegram_digest_items
          SET sent_at = NOW()
          WHERE id = $1
        `,
        [itemId],
      );
    }
  }
}
