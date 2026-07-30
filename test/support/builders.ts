import type { Pool } from 'pg';
import { seedBootstrapApiKey } from '../../src/modules/auth/api-keys.repository';

/**
 * Row builders shared by the integration suites.
 *
 * They exist so a suite states only what the case is about ("an alert for this
 * entry, in this tenant") instead of restating every NOT NULL column of the
 * schema. When a migration adds a required column, the default lands here once
 * rather than in a dozen literal INSERT statements.
 *
 * They work against both `pg.Pool` and the pg-mem pool from `./pg-mem`, because
 * the only thing they use is `query(text, values)`.
 */
export interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

type ColumnValues = Record<string, unknown>;

/**
 * Builds a parameterized INSERT from the defined columns only, so an omitted
 * fixture field falls through to the schema default (including SERIAL ids).
 */
async function insertRow(pool: QueryablePool, table: string, values: ColumnValues): Promise<string> {
  const columns = Object.keys(values).filter((column) => values[column] !== undefined);

  if (columns.length === 0) {
    throw new Error(`insert_row_requires_at_least_one_column:${table}`);
  }

  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');
  const result = await pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    columns.map((column) => values[column]),
  );

  return String(result.rows[0]?.['id']);
}

export const DEFAULT_TENANT_ID = 'tenant_test';

export interface FeedFixture {
  id?: number;
  tenantId?: string;
  url?: string;
  status?: 'active' | 'paused' | 'error';
  pollIntervalSeconds?: number;
  nextCheckAt?: Date | string;
  errorCount?: number;
  lastError?: string | null;
  normalizedUrlHash?: string | null;
  claimedAt?: Date | string | null;
}

export async function insertFeed(pool: QueryablePool, fixture: FeedFixture = {}): Promise<number> {
  const id = await insertRow(pool, 'feeds', {
    id: fixture.id,
    tenant_id: fixture.tenantId ?? DEFAULT_TENANT_ID,
    url:
      fixture.url ?? `https://feeds.example.com/${fixture.id ?? Date.now()}-${Math.random().toString(36).slice(2)}.xml`,
    status: fixture.status,
    poll_interval_seconds: fixture.pollIntervalSeconds,
    next_check_at: fixture.nextCheckAt,
    error_count: fixture.errorCount,
    last_error: fixture.lastError,
    normalized_url_hash: fixture.normalizedUrlHash,
    claimed_at: fixture.claimedAt,
  });

  return Number(id);
}

export interface RuleFixture {
  id?: number;
  tenantId?: string;
  name?: string;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  isActive?: boolean;
}

export async function insertRule(pool: QueryablePool, fixture: RuleFixture = {}): Promise<number> {
  const id = await insertRow(pool, 'rules', {
    id: fixture.id,
    tenant_id: fixture.tenantId ?? DEFAULT_TENANT_ID,
    name: fixture.name ?? 'Test rule',
    include_keywords: fixture.includeKeywords ?? ['ai'],
    exclude_keywords: fixture.excludeKeywords ?? [],
    is_active: fixture.isActive,
  });

  return Number(id);
}

export interface EntryFixture {
  id?: number;
  tenantId?: string;
  feedId: number;
  title?: string | null;
  link?: string | null;
  guid?: string | null;
  content?: string | null;
  contentHash?: string;
  publishedAt?: Date | string | null;
}

export async function insertEntry(pool: QueryablePool, fixture: EntryFixture): Promise<string> {
  return insertRow(pool, 'entries', {
    id: fixture.id,
    tenant_id: fixture.tenantId ?? DEFAULT_TENANT_ID,
    feed_id: fixture.feedId,
    title: fixture.title ?? 'Test entry',
    link: fixture.link,
    guid: fixture.guid,
    content: fixture.content ?? 'Test body',
    // Unique per row by default: the schema enforces UNIQUE (feed_id, content_hash).
    content_hash: fixture.contentHash ?? `hash_${fixture.id ?? Math.random().toString(36).slice(2)}`,
    published_at: fixture.publishedAt,
  });
}

export interface AlertFixture {
  id?: number;
  tenantId?: string;
  entryId: number | string;
  ruleId: number;
  matchedRules?: number[];
  canonicalLink?: string | null;
  sent?: boolean;
  deliveryStatus?: 'pending' | 'queued' | 'retrying' | 'sent' | 'failed' | 'disabled';
}

export async function insertAlert(pool: QueryablePool, fixture: AlertFixture): Promise<string> {
  return insertRow(pool, 'alerts', {
    id: fixture.id,
    tenant_id: fixture.tenantId ?? DEFAULT_TENANT_ID,
    entry_id: fixture.entryId,
    rule_id: fixture.ruleId,
    matched_rules: fixture.matchedRules,
    canonical_link: fixture.canonicalLink,
    sent: fixture.sent,
    delivery_status: fixture.deliveryStatus,
  });
}

export interface TenantSettingsFixture {
  tenantId: string;
  webhookNotifierUrl?: string | null;
  recipientEmails?: string[];
  telegramChatIds?: string[];
  telegramDeliveryMode?: 'instant' | 'digest_10m';
  telegramBotTokenCiphertext?: string | null;
  telegramBotTokenIv?: string | null;
  telegramBotTokenTag?: string | null;
}

export async function insertTenantSettings(pool: QueryablePool, fixture: TenantSettingsFixture): Promise<void> {
  const values: ColumnValues = {
    tenant_id: fixture.tenantId,
    webhook_notifier_url: fixture.webhookNotifierUrl,
    recipient_emails: fixture.recipientEmails,
    telegram_chat_ids: fixture.telegramChatIds,
    telegram_delivery_mode: fixture.telegramDeliveryMode,
    telegram_bot_token_ciphertext: fixture.telegramBotTokenCiphertext,
    telegram_bot_token_iv: fixture.telegramBotTokenIv,
    telegram_bot_token_tag: fixture.telegramBotTokenTag,
  };

  const columns = Object.keys(values).filter((column) => values[column] !== undefined);
  const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ');

  await pool.query(
    `INSERT INTO tenant_settings (${columns.join(', ')}) VALUES (${placeholders})`,
    columns.map((column) => values[column]),
  );
}

/**
 * Issues a real, hashed API key so a suite can authenticate over HTTP.
 *
 * Authentication verifies a hashed lookup against `api_keys`, so an arbitrary
 * header value no longer conjures a tenant: every tenant a suite talks to must
 * have a key issued here first.
 */
export async function issueApiKey(
  pool: QueryablePool,
  input: { tenantId: string; plaintextKey: string; label?: string },
): Promise<string> {
  await seedBootstrapApiKey(pool as unknown as Pool, {
    plaintextKey: input.plaintextKey,
    tenantId: input.tenantId,
    label: input.label ?? 'integration',
  });

  return input.plaintextKey;
}
