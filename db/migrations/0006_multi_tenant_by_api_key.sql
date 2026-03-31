-- Multi-tenant isolation scoped by API key-derived tenant id.

ALTER TABLE feeds ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE fetch_logs ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE opml_imports ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE opml_import_items ADD COLUMN IF NOT EXISTS tenant_id TEXT;

UPDATE feeds SET tenant_id = COALESCE(tenant_id, 'legacy');
UPDATE rules SET tenant_id = COALESCE(tenant_id, 'legacy');
UPDATE entries e
SET tenant_id = COALESCE(e.tenant_id, f.tenant_id, 'legacy')
FROM feeds f
WHERE e.feed_id = f.id;
UPDATE alerts a
SET tenant_id = COALESCE(a.tenant_id, e.tenant_id, 'legacy')
FROM entries e
WHERE a.entry_id = e.id;
UPDATE fetch_logs l
SET tenant_id = COALESCE(l.tenant_id, f.tenant_id, 'legacy')
FROM feeds f
WHERE l.feed_id = f.id;
UPDATE opml_imports SET tenant_id = COALESCE(tenant_id, 'legacy');
UPDATE opml_import_items i
SET tenant_id = COALESCE(i.tenant_id, o.tenant_id, 'legacy')
FROM opml_imports o
WHERE i.import_id = o.id;

ALTER TABLE feeds ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE rules ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE entries ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE alerts ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE fetch_logs ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE opml_imports ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE opml_import_items ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE feeds ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE rules ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE entries ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE alerts ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE fetch_logs ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE opml_imports ALTER COLUMN tenant_id SET DEFAULT 'legacy';
ALTER TABLE opml_import_items ALTER COLUMN tenant_id SET DEFAULT 'legacy';

ALTER TABLE feeds DROP CONSTRAINT IF EXISTS feeds_url_key;
DROP INDEX IF EXISTS idx_feeds_normalized_url_hash_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_tenant_url_unique
ON feeds (tenant_id, url);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_tenant_normalized_url_hash_unique
ON feeds (tenant_id, normalized_url_hash)
WHERE normalized_url_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feeds_tenant_created_at
ON feeds (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rules_tenant_created_at
ON rules (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_tenant_published
ON entries (tenant_id, published_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_created
ON alerts (tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_fetch_logs_tenant_created
ON fetch_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_opml_imports_tenant_created
ON opml_imports (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_opml_import_items_tenant_import
ON opml_import_items (tenant_id, import_id, item_status);
