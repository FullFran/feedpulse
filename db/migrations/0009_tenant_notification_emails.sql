-- Add per-tenant recipient email list for alert notifications.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS recipient_emails TEXT[] NOT NULL DEFAULT '{}';
