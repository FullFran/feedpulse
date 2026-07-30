-- API keys are the credential store behind HTTP API authentication.
-- Only the SHA-256 hash of the full key is persisted; the plaintext is shown once at creation time.
CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id);

-- Authentication only ever looks up non-revoked keys, so keep the hot path index partial.
CREATE INDEX IF NOT EXISTS idx_api_keys_active_key_hash ON api_keys (key_hash) WHERE revoked_at IS NULL;
