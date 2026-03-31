ALTER TABLE feeds
ADD COLUMN IF NOT EXISTS normalized_url_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_normalized_url_hash_unique
ON feeds (normalized_url_hash)
WHERE normalized_url_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS opml_imports (
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opml_imports_status_created_at
ON opml_imports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS opml_import_items (
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
  CONSTRAINT opml_import_items_normalized_url_required
    CHECK (item_status = 'invalid' OR (normalized_url IS NOT NULL AND normalized_url_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_opml_import_items_import_id_status
ON opml_import_items (import_id, item_status);

CREATE INDEX IF NOT EXISTS idx_opml_import_items_hash
ON opml_import_items (normalized_url_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_opml_import_items_dedupe_per_import
ON opml_import_items (import_id, normalized_url_hash)
WHERE normalized_url_hash IS NOT NULL;

-- Manual rollback guide (framework currently applies only "up" migrations):
-- DROP INDEX IF EXISTS idx_opml_import_items_dedupe_per_import;
-- DROP INDEX IF EXISTS idx_opml_import_items_hash;
-- DROP INDEX IF EXISTS idx_opml_import_items_import_id_status;
-- DROP TABLE IF EXISTS opml_import_items;
-- DROP INDEX IF EXISTS idx_opml_imports_status_created_at;
-- DROP TABLE IF EXISTS opml_imports;
-- DROP INDEX IF EXISTS idx_feeds_normalized_url_hash_unique;
-- ALTER TABLE feeds DROP COLUMN IF EXISTS normalized_url_hash;
