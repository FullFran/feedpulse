-- Telegram per-tenant settings + digest queue support.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS telegram_chat_ids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS telegram_delivery_mode TEXT NOT NULL DEFAULT 'instant'
  CHECK (telegram_delivery_mode IN ('instant', 'digest_10m'));

CREATE TABLE IF NOT EXISTS telegram_digest_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_digest_items_pending
  ON telegram_digest_items (scheduled_for, tenant_id, chat_id)
  WHERE sent_at IS NULL;
