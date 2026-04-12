-- Migration 0013: Per-channel delivery tracking and one-alert-per-article aggregation
-- Addresses: 
--   1. Per-channel success state to prevent duplicate retries
--   2. One alert per article instead of one per rule
--   3. Word-boundary matching (done in app, not migration)

-- Step 1: Add column to store matched rules as array
ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS matched_rules INTEGER[] NOT NULL DEFAULT '{}';

-- Step 2: Add per-channel delivery tracking columns
-- Each channel can have its own status: pending, sent, failed
ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS webhook_delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (webhook_delivery_status IN ('pending', 'sent', 'failed'));

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS telegram_delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (telegram_delivery_status IN ('pending', 'sent', 'failed'));

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (email_delivery_status IN ('pending', 'sent', 'failed'));

-- Step 3: Update existing alerts to set initial channel statuses based on sent status
UPDATE alerts
SET 
  matched_rules = ARRAY[rule_id],
  webhook_delivery_status = CASE WHEN delivery_status = 'sent' THEN 'sent' ELSE 'pending' END,
  telegram_delivery_status = CASE WHEN delivery_status = 'sent' THEN 'sent' ELSE 'pending' END,
  email_delivery_status = CASE WHEN delivery_status = 'sent' THEN 'sent' ELSE 'pending' END;

-- Step 4: Drop old unique constraint that creates one alert per rule
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_entry_id_rule_id_key;

-- Step 5: Create new unique constraint for one alert per article (tenant + canonical_link)
-- First, remove duplicates keeping one alert per canonical link per tenant
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, canonical_link
      ORDER BY created_at ASC, id ASC
    ) AS row_num
  FROM alerts
  WHERE canonical_link IS NOT NULL
)
DELETE FROM alerts a
USING ranked r
WHERE a.id = r.id
  AND r.row_num > 1;

-- Step 6: Add new unique index (one alert per canonical link per tenant)
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_tenant_canonical_link_unique
ON alerts (tenant_id, canonical_link)
WHERE canonical_link IS NOT NULL;

-- Step 7: Add indexes for efficient channel status queries
CREATE INDEX IF NOT EXISTS idx_alerts_webhook_status_pending
ON alerts (id, tenant_id)
WHERE webhook_delivery_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_alerts_telegram_status_pending
ON alerts (id, tenant_id)
WHERE telegram_delivery_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_alerts_email_status_pending
ON alerts (id, tenant_id)
WHERE email_delivery_status = 'pending';