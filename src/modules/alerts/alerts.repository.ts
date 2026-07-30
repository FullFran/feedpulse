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

/**
 * Outcome of one aggregated alert upsert batch.
 *
 * PRODUCT DECISION (deliberate, do not "fix" by resetting `sent`): when a newly
 * activated rule matches an article that already produced an alert, the alert's
 * `matched_rules` grows but no notification is sent again. `DeliverAlertUseCase`
 * would answer `already_sent`, and re-opening delivery would push an article the
 * user has already seen back into their inbox. Those alerts are reported
 * separately in `ruleSetExtended` so ingestion can log the event instead of
 * swallowing it; a dedicated "rules changed" digest is the follow-up, not a
 * `sent = false` reset.
 */
export interface AlertUpsertOutcome {
  /** Alerts this batch genuinely inserted. Only these are worth delivering. */
  created: CreatedAlert[];
  /** Pre-existing alerts whose matched-rule set grew. Already delivered; not re-delivered. */
  ruleSetExtended: CreatedAlert[];
}

/**
 * Physical column backing each delivery channel.
 *
 * This is the only place in the repository where a value ends up in SQL text
 * rather than in a placeholder, so the mapping is a frozen literal table and an
 * unknown channel throws. The TypeScript union alone is not a runtime
 * guarantee: types are erased, and a channel string arriving from a queue
 * payload would otherwise be interpolated straight into the statement.
 */
const CHANNEL_DELIVERY_STATUS_COLUMNS = Object.freeze({
  webhook: 'webhook_delivery_status',
  telegram: 'telegram_delivery_status',
  email: 'email_delivery_status',
} as const);

export type DeliveryChannel = keyof typeof CHANNEL_DELIVERY_STATUS_COLUMNS;

function deliveryStatusColumn(channel: DeliveryChannel): string {
  if (!Object.prototype.hasOwnProperty.call(CHANNEL_DELIVERY_STATUS_COLUMNS, channel)) {
    throw new Error(`unknown_alert_delivery_channel:${String(channel)}`);
  }

  return CHANNEL_DELIVERY_STATUS_COLUMNS[channel];
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

  /**
   * Upsert one alert per article for a whole ingestion batch.
   *
   * Two round-trips total (one read of the entries, one write), regardless of
   * batch size. The previous implementation issued a SELECT, then an UPDATE or
   * an INSERT per entry — roughly three round-trips per matched entry inside an
   * open transaction, so a 200-item feed cost ~600 — and its read-modify-write
   * on `matched_rules` could lose a concurrently appended rule.
   *
   * Dedupe is delegated to the unique index created by migration 0018 on
   * `(tenant_id, COALESCE(canonical_link, 'entry:' || entry_id::text))`. The
   * `ON CONFLICT` inference expression must stay byte-for-byte identical to that
   * index definition or Postgres refuses the statement at runtime. Using the
   * COALESCE fallback (rather than the partial index from 0013) also covers
   * entries with no usable link, which otherwise duplicate freely because a
   * partial index does not constrain NULLs.
   *
   * `xmax = 0` is true only for tuples this statement inserted, which is what
   * separates a genuinely new alert (deliver it, count it) from an existing one
   * that merely gained a rule (do not re-deliver).
   *
   * @param matchesByEntry entryId -> matching rule IDs
   */
  async createForEntryWithRules(
    matchesByEntry: Map<string, number[]>,
    executor: QueryExecutor = this.databaseService,
  ): Promise<AlertUpsertOutcome> {
    const entryIds = [...matchesByEntry.entries()]
      .filter(([, ruleIds]) => ruleIds.length > 0)
      .map(([entryId]) => entryId);

    if (entryIds.length === 0) {
      return { created: [], ruleSetExtended: [] };
    }

    const entriesResult = await executor.query<{ id: string; tenant_id: string; link: string | null }>(
      `
        SELECT id::text AS id, tenant_id, link
        FROM entries
        WHERE id = ANY($1::bigint[])
        ORDER BY id ASC
      `,
      [entryIds],
    );

    // Collapse entries that share a dedupe key before hitting the database:
    // Postgres rejects an ON CONFLICT DO UPDATE that would touch the same row
    // twice in one statement, and one feed can legitimately publish the same
    // article under two items.
    const upserts = new Map<
      string,
      { tenantId: string; entryId: string; ruleIds: Set<number>; canonicalLink: string | null }
    >();

    for (const row of entriesResult.rows) {
      const ruleIds = matchesByEntry.get(row.id);

      if (!ruleIds || ruleIds.length === 0) {
        continue;
      }

      const canonicalLink = canonicalizeArticleLink(row.link);
      // ASCII unit separator (U+001F), not NUL: a literal NUL byte in the source makes
      // ripgrep classify this whole file as binary and skip it in ordinary searches.
      // U+001F is equally collision-safe here — it cannot occur in a tenant id or a URL.
      const dedupeKey = `${row.tenant_id}\u001f${canonicalLink ?? `entry:${row.id}`}`;
      const pending = upserts.get(dedupeKey);

      if (pending) {
        for (const ruleId of ruleIds) {
          pending.ruleIds.add(ruleId);
        }
        continue;
      }

      upserts.set(dedupeKey, {
        tenantId: row.tenant_id,
        entryId: row.id,
        ruleIds: new Set(ruleIds),
        canonicalLink,
      });
    }

    if (upserts.size === 0) {
      return { created: [], ruleSetExtended: [] };
    }

    const tenantIds: string[] = [];
    const upsertEntryIds: string[] = [];
    const primaryRuleIds: number[] = [];
    // Postgres cannot unnest an array of arrays, so matched_rules travels as
    // array literals in a text[] and is cast back per row.
    const matchedRuleLiterals: string[] = [];
    const canonicalLinks: Array<string | null> = [];

    for (const upsert of upserts.values()) {
      const sortedRuleIds = [...upsert.ruleIds].sort((a, b) => a - b);
      const primaryRuleId = sortedRuleIds[0];

      // Entries are only added to `upserts` with at least one matched rule, so
      // this is unreachable in practice. It stays as a guard rather than a
      // non-null assertion because an alert has no meaning without a primary
      // rule: skipping is correct, inserting `undefined` into a bigint[] is not.
      if (primaryRuleId === undefined) {
        continue;
      }

      tenantIds.push(upsert.tenantId);
      upsertEntryIds.push(upsert.entryId);
      primaryRuleIds.push(primaryRuleId);
      matchedRuleLiterals.push(`{${sortedRuleIds.join(',')}}`);
      canonicalLinks.push(upsert.canonicalLink);
    }

    const result = await executor.query<{ id: string; entry_id: string; rule_id: number; inserted: boolean }>(
      `
        INSERT INTO alerts (tenant_id, entry_id, rule_id, matched_rules, canonical_link)
        SELECT v.tenant_id, v.entry_id, v.rule_id, v.matched_rules::int[], v.canonical_link
        FROM unnest($1::text[], $2::bigint[], $3::int[], $4::text[], $5::text[])
          AS v(tenant_id, entry_id, rule_id, matched_rules, canonical_link)
        ON CONFLICT (tenant_id, (COALESCE(canonical_link, 'entry:' || entry_id::text)))
        DO UPDATE SET matched_rules = ARRAY(
          SELECT DISTINCT unnest(alerts.matched_rules || EXCLUDED.matched_rules) ORDER BY 1
        )
        RETURNING id::text AS id, entry_id::text AS entry_id, rule_id, (xmax = 0) AS inserted
      `,
      [tenantIds, upsertEntryIds, primaryRuleIds, matchedRuleLiterals, canonicalLinks],
    );

    const created: CreatedAlert[] = [];
    const ruleSetExtended: CreatedAlert[] = [];

    for (const row of result.rows) {
      const alert: CreatedAlert = { id: row.id, entryId: row.entry_id, ruleId: row.rule_id };
      (row.inserted ? created : ruleSetExtended).push(alert);
    }

    return { created, ruleSetExtended };
  }

  async list(input: {
    tenantId: string;
    page: number;
    pageSize: number;
    sent?: boolean;
  }): Promise<{ items: AlertView[]; total: number }> {
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

  /**
   * Column list shared by every alert-detail lookup. Kept in one place so the tenant-scoped
   * and the deliberately unscoped variant can never drift apart.
   */
  private static readonly ALERT_DETAIL_SELECT = `
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
  `;

  /**
   * Tenant-scoped alert lookup. Always pass a tenant id from an authenticated request.
   *
   * TODO(tenant-isolation): make `tenantId` required and let the two cross-tenant callers use
   * `findByIdForWorker` explicitly. Blocked by two files outside this unit's edit scope:
   * `alerts/application/get-alert.use-case.ts` (declares `tenantId?: string`) and
   * `alerts/application/process-alert-delivery.use-case.ts` (calls `findById(input.alertId)`).
   * Until then, an omitted tenant id is routed through `findByIdForWorker` so the widening is
   * at least explicit in one place instead of being a hidden branch inside the SQL.
   */
  async findById(id: number, tenantId?: string): Promise<AlertNotificationRecord | null> {
    return tenantId === undefined ? this.findByIdForWorker(id) : this.findByIdForTenant(id, tenantId);
  }

  /** Tenant-scoped alert lookup with a REQUIRED tenant id. */
  async findByIdForTenant(id: number, tenantId: string): Promise<AlertNotificationRecord | null> {
    const result = await this.databaseService.query<AlertRow>(
      `${AlertsRepository.ALERT_DETAIL_SELECT} WHERE a.id = $1 AND a.tenant_id = $2`,
      [id, tenantId],
    );

    return result.rows[0] ? mapAlert(result.rows[0]) : null;
  }

  /**
   * Deliberately cross-tenant alert lookup for queue consumers, which are handed an alert id
   * by BullMQ and derive the tenant from the row they read. Never reachable from an HTTP
   * handler. Grep for this name to enumerate every cross-tenant alert read.
   */
  async findByIdForWorker(id: number): Promise<AlertNotificationRecord | null> {
    const result = await this.databaseService.query<AlertRow>(
      `${AlertsRepository.ALERT_DETAIL_SELECT} WHERE a.id = $1`,
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
  async markChannelDelivered(
    id: number,
    channel: DeliveryChannel,
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    const column = deliveryStatusColumn(channel);
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
   * Mark a specific channel as terminally failed for this alert.
   *
   * Used for failures that a retry cannot fix — today only "the tenant burned
   * its daily email quota". Leaving such a channel on `pending` is the worse
   * option: `checkAllChannelsDelivered` would never converge, the alert would
   * sit in `pending` forever and the operator would have no idea why. A
   * `failed` channel is at least visible in `GET /alerts`.
   *
   * A channel already marked `sent` is never demoted: a later attempt that
   * fails must not erase a delivery the reader already received.
   */
  async markChannelFailed(
    id: number,
    channel: DeliveryChannel,
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    const column = deliveryStatusColumn(channel);
    await executor.query(
      `
        UPDATE alerts
        SET ${column} = 'failed',
            last_delivery_attempt_at = NOW()
        WHERE id = $1
          AND ${column} <> 'sent'
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
  async markDeliveryRetryPending(
    id: number,
    attemptNumber: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
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

      const firstItem = itemsResult.rows[0];

      if (!firstItem) {
        continue;
      }

      result.push({
        tenantId: group.tenant_id,
        chatId: group.chat_id,
        scheduledFor: firstItem.scheduled_for.toISOString(),
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

  /**
   * Flush one digest group: mark its items sent, then converge the Telegram
   * channel of every alert that has no unsent digest item left.
   *
   * Without the second half, `alerts.telegram_delivery_status` stayed `'pending'`
   * forever for every `digest_10m` tenant — the digest went out, but the API,
   * the dashboard and the `idx_alerts_telegram_status_pending` partial index all
   * kept reporting the alert as undelivered.
   *
   * The convergence guard is `id NOT IN (unsent digest items)`, so an alert
   * fanned out to several chat ids is only marked once the LAST chat has been
   * flushed. `telegram_digest_items.alert_id` is `NOT NULL`, so the classic
   * `NOT IN` NULL trap cannot apply here.
   *
   * WHY NOT ONE STATEMENT: a data-modifying CTE (`WITH marked AS (UPDATE …)`)
   * would make item-marking and convergence atomic, but pg-mem — the engine
   * behind the emulator-backed integration suites — rejects it outright
   * ("WITH nested statement with query type 'update'"), and `DatabaseService`
   * exposes no client checkout, so an explicit transaction is not reachable
   * from a pg-mem pool either. The crash window between the two writes is
   * closed by `reconcileTelegramDigestDeliveryStatus`, which every sweep runs
   * first — a crash here self-heals on the next tick instead of leaving a
   * permanently pending channel.
   *
   * @returns ids of the alerts whose Telegram channel this call converged.
   */
  async markTelegramDigestGroupSent(
    items: ReadonlyArray<{ digestItemId: number; alertId: string }>,
  ): Promise<{ alertIdsDelivered: string[] }> {
    if (!items.length) {
      return { alertIdsDelivered: [] };
    }

    for (const item of items) {
      await this.databaseService.query(
        `
          UPDATE telegram_digest_items
          SET sent_at = NOW()
          WHERE id = $1
            AND sent_at IS NULL
        `,
        [item.digestItemId],
      );
    }

    const alertIdsDelivered: string[] = [];
    for (const alertId of new Set(items.map((item) => item.alertId))) {
      const converged = await this.databaseService.query<{ id: string }>(
        `
          UPDATE alerts
          SET telegram_delivery_status = 'sent',
              last_delivery_attempt_at = NOW()
          WHERE id = $1
            AND telegram_delivery_status <> 'sent'
            AND id NOT IN (SELECT alert_id FROM telegram_digest_items WHERE sent_at IS NULL)
          RETURNING id
        `,
        [alertId],
      );

      const convergedRow = converged.rows[0];

      if (convergedRow) {
        alertIdsDelivered.push(String(convergedRow.id));
      }
    }

    return { alertIdsDelivered };
  }

  /**
   * Converge every digest-mode alert whose items are all sent but whose Telegram
   * channel is still `'pending'`.
   *
   * Two jobs in one query. It closes the crash window inside
   * `markTelegramDigestGroupSent`, and it repairs the backlog left by the
   * versions of this code that never marked the channel at all — those rows
   * would otherwise stay in the partial pending index forever.
   *
   * Only alerts that actually have digest items are touched, so an instant-mode
   * alert whose Telegram send failed is never silently promoted to `'sent'`.
   *
   * @returns ids of the alerts repaired by this pass.
   */
  async reconcileTelegramDigestDeliveryStatus(): Promise<{ alertIdsDelivered: string[] }> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        UPDATE alerts
        SET telegram_delivery_status = 'sent',
            last_delivery_attempt_at = NOW()
        WHERE telegram_delivery_status = 'pending'
          AND id IN (SELECT alert_id FROM telegram_digest_items WHERE sent_at IS NOT NULL)
          AND id NOT IN (SELECT alert_id FROM telegram_digest_items WHERE sent_at IS NULL)
        RETURNING id
      `,
    );

    return { alertIdsDelivered: result.rows.map((row) => String(row.id)) };
  }
}
