-- Encrypted per-tenant telegram bot token storage.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS telegram_bot_token_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS telegram_bot_token_iv TEXT,
  ADD COLUMN IF NOT EXISTS telegram_bot_token_tag TEXT;
