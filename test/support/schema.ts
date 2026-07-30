import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expectDefined } from './expect-defined';
import type { PgMemHandle, PgMemPool } from './pg-mem';
import { createPgMemPool } from './pg-mem';

/**
 * THE single source of truth for the pg-mem schema.
 *
 * Before this file existed, four suites each hand-wrote their own subset of the
 * schema. They had already drifted: one still declared the `UNIQUE (entry_id,
 * rule_id)` constraint migration 0013 drops, another kept the
 * `idx_alerts_tenant_rule_canonical_link_unique` index migration 0018 drops, and
 * none of them had `feeds.claimed_at` (migration 0015). A repository could
 * therefore pass its tests against a schema production has not had for months.
 *
 * The statements below reproduce the end state of `db/migrations/0001..0021`,
 * with the differences pg-mem forces on us listed in
 * `KNOWN_SCHEMA_DIVERGENCES`. `test/schema-parity.integration-spec.ts` diffs
 * this schema against the real migrations and fails on anything not declared
 * there, so drift cannot reappear silently.
 */
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

/**
 * Tables that only exist to satisfy the migration runner and carry no
 * application data. The parity spec still checks them.
 */
export const PG_MEM_SCHEMA_STATEMENTS: readonly string[] = [
  // ---------------------------------------------------------------- 0001 + 0006 + 0003 + 0015
  `CREATE TABLE schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE feeds (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
    etag TEXT,
    last_modified TEXT,
    last_checked_at TIMESTAMPTZ,
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    poll_interval_seconds INT NOT NULL DEFAULT 1800,
    error_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    avg_response_ms INT,
    avg_items_per_day DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    normalized_url_hash TEXT,
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    claimed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX idx_feeds_next_check_active ON feeds (next_check_at) WHERE status = 'active'`,
  `CREATE UNIQUE INDEX idx_feeds_tenant_url_unique ON feeds (tenant_id, url)`,
  `CREATE UNIQUE INDEX idx_feeds_tenant_normalized_url_hash_unique
    ON feeds (tenant_id, normalized_url_hash)
    WHERE normalized_url_hash IS NOT NULL`,
  `CREATE INDEX idx_feeds_tenant_created_at ON feeds (tenant_id, created_at DESC)`,
  `CREATE INDEX idx_feeds_claimed_at ON feeds (claimed_at) WHERE claimed_at IS NOT NULL`,

  // ---------------------------------------------------------------- 0001 + 0006 + 0016
  `CREATE TABLE entries (
    id BIGSERIAL PRIMARY KEY,
    feed_id INT NOT NULL REFERENCES feeds(id),
    title TEXT,
    link TEXT,
    guid TEXT,
    content TEXT,
    content_hash TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    normalized_search_document TEXT GENERATED ALWAYS AS (
      feedpulse_normalize_search_text(COALESCE(title, '') || ' ' || COALESCE(content, ''))
    ) STORED,
    UNIQUE (feed_id, guid),
    UNIQUE (feed_id, content_hash)
  )`,
  `CREATE INDEX idx_entries_feed_published ON entries (feed_id, published_at DESC)`,
  `CREATE INDEX idx_entries_feed_published_id ON entries (feed_id, published_at DESC, id DESC)`,
  `CREATE INDEX idx_entries_tenant_published ON entries (tenant_id, published_at DESC NULLS LAST, id DESC)`,

  // ---------------------------------------------------------------- 0001 + 0006
  `CREATE TABLE fetch_logs (
    id BIGSERIAL PRIMARY KEY,
    feed_id INT NOT NULL REFERENCES feeds(id),
    status_code INT,
    response_time_ms INT,
    error BOOLEAN NOT NULL DEFAULT FALSE,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id TEXT NOT NULL DEFAULT 'legacy'
  )`,
  `CREATE INDEX idx_fetch_logs_feed_created ON fetch_logs (feed_id, created_at DESC)`,
  `CREATE INDEX idx_fetch_logs_tenant_created ON fetch_logs (tenant_id, created_at DESC)`,

  // ---------------------------------------------------------------- 0001 + 0006 + 0020
  `CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    include_keywords TEXT[] NOT NULL,
    exclude_keywords TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id TEXT NOT NULL DEFAULT 'legacy'
  )`,
  `CREATE INDEX idx_rules_tenant_created_at ON rules (tenant_id, created_at DESC)`,
  // Migration 0020. Required by `RulesRepository.upsertByName` and
  // `insertIgnoreOnConflict`, which infer `ON CONFLICT (tenant_id, name)` from it.
  `CREATE UNIQUE INDEX idx_rules_tenant_name_unique ON rules (tenant_id, name)`,

  // ---------------------------------------------------------------- 0001 + 0002 + 0006 + 0012 + 0013 + 0018
  // NOTE: no `UNIQUE (entry_id, rule_id)`; migration 0013 drops it so one alert
  // can carry several rules in `matched_rules`.
  `CREATE TABLE alerts (
    id BIGSERIAL PRIMARY KEY,
    entry_id BIGINT NOT NULL REFERENCES entries(id),
    rule_id INT NOT NULL REFERENCES rules(id),
    sent BOOLEAN NOT NULL DEFAULT FALSE,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivery_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (delivery_status IN ('pending', 'queued', 'retrying', 'sent', 'failed', 'disabled')),
    delivery_attempts INT NOT NULL DEFAULT 0,
    last_delivery_attempt_at TIMESTAMPTZ,
    last_delivery_error TEXT,
    last_delivery_queued_at TIMESTAMPTZ,
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    canonical_link TEXT,
    matched_rules INTEGER[] NOT NULL DEFAULT '{}',
    webhook_delivery_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (webhook_delivery_status IN ('pending', 'sent', 'failed')),
    telegram_delivery_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (telegram_delivery_status IN ('pending', 'sent', 'failed')),
    email_delivery_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (email_delivery_status IN ('pending', 'sent', 'failed'))
  )`,
  `CREATE INDEX idx_alerts_sent_created ON alerts (sent, created_at DESC)`,
  `CREATE INDEX idx_alerts_delivery_status_created ON alerts (delivery_status, created_at DESC)`,
  `CREATE INDEX idx_alerts_tenant_created ON alerts (tenant_id, created_at DESC, id DESC)`,
  `CREATE INDEX idx_alerts_webhook_status_pending ON alerts (id, tenant_id) WHERE webhook_delivery_status = 'pending'`,
  `CREATE INDEX idx_alerts_telegram_status_pending ON alerts (id, tenant_id) WHERE telegram_delivery_status = 'pending'`,
  `CREATE INDEX idx_alerts_email_status_pending ON alerts (id, tenant_id) WHERE email_delivery_status = 'pending'`,
  // Migration 0018 replaces both partial indexes with this total one. pg-mem
  // parses the expression and enforces uniqueness on it, but it cannot serve as
  // an `ON CONFLICT` inference target, which is why the alert upsert suites use
  // a real PostgreSQL.
  `CREATE UNIQUE INDEX idx_alerts_tenant_dedupe_key_unique
    ON alerts (tenant_id, (COALESCE(canonical_link, 'entry:' || entry_id::text)))`,

  // ---------------------------------------------------------------- 0008 + 0009 + 0010 + 0011 + 0021
  `CREATE TABLE tenant_settings (
    tenant_id TEXT PRIMARY KEY,
    webhook_notifier_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recipient_emails TEXT[] NOT NULL DEFAULT '{}',
    telegram_chat_ids TEXT[] NOT NULL DEFAULT '{}',
    telegram_delivery_mode TEXT NOT NULL DEFAULT 'instant'
      CHECK (telegram_delivery_mode IN ('instant', 'digest_10m')),
    telegram_bot_token_ciphertext TEXT,
    telegram_bot_token_iv TEXT,
    telegram_bot_token_tag TEXT,
    telegram_bot_token_key_version INT NOT NULL DEFAULT 1
  )`,

  // ---------------------------------------------------------------- 0010
  `CREATE TABLE telegram_digest_items (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (alert_id, chat_id)
  )`,
  `CREATE INDEX idx_telegram_digest_items_pending
    ON telegram_digest_items (scheduled_for, tenant_id, chat_id)
    WHERE sent_at IS NULL`,

  // ---------------------------------------------------------------- 0003 + 0005 + 0006
  `CREATE TABLE opml_imports (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsing', 'preview_ready', 'importing', 'completed', 'failed_validation', 'failed')),
    file_name TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
    source_checksum TEXT,
    error_message TEXT,
    total_items INT NOT NULL DEFAULT 0 CHECK (total_items >= 0),
    valid_items INT NOT NULL DEFAULT 0 CHECK (valid_items >= 0),
    duplicate_items INT NOT NULL DEFAULT 0 CHECK (duplicate_items >= 0),
    existing_items INT NOT NULL DEFAULT 0 CHECK (existing_items >= 0),
    invalid_items INT NOT NULL DEFAULT 0 CHECK (invalid_items >= 0),
    imported_items INT NOT NULL DEFAULT 0 CHECK (imported_items >= 0),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id TEXT NOT NULL DEFAULT 'legacy'
  )`,
  `CREATE INDEX idx_opml_imports_status_created_at ON opml_imports (status, created_at DESC)`,
  `CREATE INDEX idx_opml_imports_tenant_created ON opml_imports (tenant_id, created_at DESC)`,
  `CREATE TABLE opml_import_items (
    id BIGSERIAL PRIMARY KEY,
    import_id BIGINT NOT NULL REFERENCES opml_imports(id) ON DELETE CASCADE,
    title TEXT,
    outline_path TEXT,
    source_xml_url TEXT,
    normalized_url TEXT,
    normalized_url_hash TEXT,
    feed_id INT REFERENCES feeds(id) ON DELETE SET NULL,
    item_status TEXT NOT NULL CHECK (item_status IN ('new', 'existing', 'duplicate', 'invalid', 'imported', 'failed')),
    validation_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tenant_id TEXT NOT NULL DEFAULT 'legacy',
    CONSTRAINT opml_import_items_normalized_url_required
      CHECK (item_status = 'invalid' OR (normalized_url IS NOT NULL AND normalized_url_hash IS NOT NULL))
  )`,
  `CREATE INDEX idx_opml_import_items_import_id_status ON opml_import_items (import_id, item_status)`,
  `CREATE INDEX idx_opml_import_items_hash ON opml_import_items (normalized_url_hash)`,
  `CREATE INDEX idx_opml_import_items_tenant_import ON opml_import_items (tenant_id, import_id, item_status)`,
  `CREATE UNIQUE INDEX idx_opml_import_items_dedupe_per_import
    ON opml_import_items (import_id, normalized_url_hash)
    WHERE normalized_url_hash IS NOT NULL AND item_status <> 'duplicate'`,

  // ---------------------------------------------------------------- 0014
  `CREATE TABLE api_keys (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
  )`,
  `CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id)`,
  `CREATE INDEX idx_api_keys_active_key_hash ON api_keys (key_hash) WHERE revoked_at IS NULL`,

  // ---------------------------------------------------------------- 0019
  `CREATE TABLE dead_letter_jobs (
    id BIGSERIAL PRIMARY KEY,
    queue TEXT NOT NULL,
    job_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    error TEXT,
    attempts INT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX idx_dead_letter_jobs_queue_failed_at ON dead_letter_jobs (queue, failed_at DESC)`,
  `CREATE INDEX idx_dead_letter_jobs_failed_at ON dead_letter_jobs (failed_at)`,
];

/**
 * Named indexes the real migrations create but the pg-mem schema deliberately
 * does not. The parity spec subtracts exactly these and fails on anything else.
 */
export const PG_MEM_OMITTED_INDEXES: readonly string[] = ['idx_entries_normalized_search_document_tsv'];

/**
 * Divergences between `PG_MEM_SCHEMA_STATEMENTS` and the real migrations that
 * the parity spec must tolerate. Each entry needs a reason; an undeclared
 * difference fails the spec.
 */
export const KNOWN_SCHEMA_DIVERGENCES: ReadonlyArray<{ readonly what: string; readonly why: string }> = [
  {
    what: 'entries.normalized_search_document is GENERATED from a JavaScript shim',
    why: 'pg-mem has no normalize(..., NFD); test/support/pg-mem.ts binds feedpulse_normalize_search_text to the TypeScript normalizer, which produces identical values.',
  },
  {
    what: 'the GIN index idx_entries_normalized_search_document_tsv is omitted',
    why: 'pg-mem has no full-text search; the index would never be used and to_tsvector is only a parsing shim.',
  },
  {
    what: 'column order differs',
    why: 'the migrations append columns with ALTER TABLE ADD COLUMN; the emulator declares them inline. Order is not observable through any query the application makes.',
  },
  {
    what: 'BIGINT columns are reported as `integer`',
    why: 'pg-mem has no 64-bit integer type in information_schema, so the parity spec folds bigint into integer. It still catches a column changing between, say, text and integer.',
  },
  {
    what: 'nullability is not compared',
    why: 'pg-mem reports is_nullable = NO for every column, including nullable ones, so the comparison would be noise rather than signal.',
  },
];

/**
 * Extracts the explicitly named indexes declared by `PG_MEM_SCHEMA_STATEMENTS`.
 *
 * Only `idx_*` names are considered: primary keys and inline UNIQUE constraints
 * get server-generated names that pg-mem and PostgreSQL do not agree on.
 */
export function declaredPgMemIndexNames(): string[] {
  return PG_MEM_SCHEMA_STATEMENTS.flatMap((statement) => {
    const match = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(idx_[a-z0-9_]+)/i.exec(statement);

    return match ? [expectDefined(match[1])] : [];
  }).sort();
}

/**
 * Applies the shared pg-mem schema to a pool created by `createPgMemPool()`.
 */
export async function applyPgMemSchema(pool: PgMemPool): Promise<void> {
  for (const statement of PG_MEM_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

/**
 * One call for the common case: a fresh in-memory database with the full schema.
 */
export async function createPgMemPoolWithSchema(): Promise<PgMemHandle> {
  const handle = createPgMemPool();
  await applyPgMemSchema(handle.pool);

  return handle;
}

/**
 * Reads `db/migrations/*.sql` in lexicographic order, which is the same order
 * the production runner applies them in.
 */
export async function readMigrationFiles(): Promise<Array<{ name: string; sql: string }>> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') })));
}

/**
 * Drops and recreates `schemaName` in a REAL PostgreSQL database, then applies
 * every migration to it.
 *
 * The suites that need genuine PostgreSQL semantics (the alert upsert, the
 * generated column, `xmax`) each own a schema so they can share one throwaway
 * database without stepping on each other.
 */
export async function resetSchemaWithMigrations(
  pool: { query(text: string, values?: unknown[]): Promise<unknown> },
  schemaName: string,
): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schemaName}`);

  for (const migration of await readMigrationFiles()) {
    await pool.query(migration.sql);
  }
}
