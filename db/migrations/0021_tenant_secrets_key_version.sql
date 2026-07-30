-- Migration 0021: record which master-key derivation produced each stored
-- tenant Telegram bot token.
--
-- WHY THIS EXISTS
-- Nothing recorded which key encrypted telegram_bot_token_ciphertext/iv/tag, so
-- rotating TENANT_SECRETS_MASTER_KEY made every stored token undecryptable and
-- the resolver swallowed that as a WARN and fell back to the GLOBAL
-- TELEGRAM_BOT_TOKEN. A botched rotation therefore rerouted every tenant's
-- Telegram traffic through the operator's own bot instead of failing loudly.
--
-- VERSION VOCABULARY (mirrored by src/modules/settings/tenant-secrets.service.ts)
--   1 = legacy: AES-256-GCM under an unsalted sha256(TENANT_SECRETS_MASTER_KEY),
--       no additional authenticated data. Every row that exists at the moment
--       this migration runs was written this way, which is why 1 is the DEFAULT
--       and the backfill value: anything else would orphan them.
--   2 = current: AES-256-GCM under a scrypt-derived key, with the GCM AAD bound
--       to tenant_id so a ciphertext cannot be moved between tenant rows.
--
-- Rows with a NULL ciphertext carry a meaningless version; the column is only
-- read when telegram_bot_token_ciphertext IS NOT NULL. The application upgrades
-- version-1 rows to version 2 in place the next time the token is read or
-- written, so no operator action is required.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS telegram_bot_token_key_version INT NOT NULL DEFAULT 1;
