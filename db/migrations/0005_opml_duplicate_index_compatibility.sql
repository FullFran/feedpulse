DROP INDEX IF EXISTS idx_opml_import_items_dedupe_per_import;

CREATE UNIQUE INDEX IF NOT EXISTS idx_opml_import_items_dedupe_per_import
ON opml_import_items (import_id, normalized_url_hash)
WHERE normalized_url_hash IS NOT NULL AND item_status <> 'duplicate';

-- Manual rollback guide (framework currently applies only "up" migrations):
-- DROP INDEX IF EXISTS idx_opml_import_items_dedupe_per_import;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_opml_import_items_dedupe_per_import
-- ON opml_import_items (import_id, normalized_url_hash)
-- WHERE normalized_url_hash IS NOT NULL;
