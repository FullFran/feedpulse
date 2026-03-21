import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';

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
  rule_id: number;
  rule_name: string;
  rule_include_keywords: string[];
  rule_exclude_keywords: string[];
}

export interface CreatedAlert {
  id: string;
  entryId: string;
  ruleId: number;
}

export interface AlertNotificationRecord extends AlertView {
  entry: AlertView['entry'] & {
    content: string | null;
  };
  rule: AlertView['rule'] & {
    includeKeywords: string[];
    excludeKeywords: string[];
  };
}

function mapAlert(row: AlertRow): AlertNotificationRecord {
  return {
    id: row.id,
    sent: row.sent,
    sentAt: row.sent_at?.toISOString() ?? null,
    deliveryStatus: row.delivery_status,
    deliveryAttempts: row.delivery_attempts,
    lastDeliveryAttemptAt: row.last_delivery_attempt_at?.toISOString() ?? null,
    lastDeliveryError: row.last_delivery_error,
    lastDeliveryQueuedAt: row.last_delivery_queued_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
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
      const result = await executor.query<{ id: string }>(
        `
          INSERT INTO alerts (entry_id, rule_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [match.entryId, match.ruleId],
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

  async list(input: { page: number; pageSize: number; sent?: boolean }): Promise<{ items: AlertView[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (typeof input.sent === 'boolean') {
      where.push(`a.sent = $${values.length + 1}`);
      values.push(input.sent);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;
    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<AlertRow>(
        `
          SELECT a.id,
                 a.sent,
                 a.sent_at,
                 a.delivery_status,
                 a.delivery_attempts,
                 a.last_delivery_attempt_at,
                 a.last_delivery_error,
                 a.last_delivery_queued_at,
                 a.created_at,
                 e.id AS entry_id,
                 e.title AS entry_title,
                 e.link AS entry_link,
                 e.content AS entry_content,
                 r.id AS rule_id,
                 r.name AS rule_name,
                 r.include_keywords AS rule_include_keywords,
                 r.exclude_keywords AS rule_exclude_keywords
          FROM alerts a
          INNER JOIN entries e ON e.id = a.entry_id
          INNER JOIN rules r ON r.id = a.rule_id
          ${clause}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, input.pageSize, offset],
      ),
      this.databaseService.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM alerts a ${clause}`, values),
    ]);

    return {
      items: itemsResult.rows.map(mapAlert),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  async findById(id: number): Promise<AlertNotificationRecord | null> {
    const result = await this.databaseService.query<AlertRow>(
      `
        SELECT a.id,
               a.sent,
               a.sent_at,
               a.delivery_status,
               a.delivery_attempts,
               a.last_delivery_attempt_at,
               a.last_delivery_error,
               a.last_delivery_queued_at,
               a.created_at,
               e.id AS entry_id,
               e.title AS entry_title,
               e.link AS entry_link,
               e.content AS entry_content,
               r.id AS rule_id,
               r.name AS rule_name,
               r.include_keywords AS rule_include_keywords,
               r.exclude_keywords AS rule_exclude_keywords
        FROM alerts a
        INNER JOIN entries e ON e.id = a.entry_id
        INNER JOIN rules r ON r.id = a.rule_id
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
}
