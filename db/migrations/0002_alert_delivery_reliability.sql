ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (delivery_status IN ('pending', 'queued', 'retrying', 'sent', 'failed', 'disabled'));

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS last_delivery_attempt_at TIMESTAMPTZ;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS last_delivery_error TEXT;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS last_delivery_queued_at TIMESTAMPTZ;

UPDATE alerts
SET delivery_status = CASE
    WHEN sent THEN 'sent'
    ELSE 'pending'
  END
WHERE delivery_status NOT IN ('pending', 'queued', 'retrying', 'sent', 'failed', 'disabled');

CREATE INDEX IF NOT EXISTS idx_alerts_delivery_status_created
ON alerts (delivery_status, created_at DESC);
