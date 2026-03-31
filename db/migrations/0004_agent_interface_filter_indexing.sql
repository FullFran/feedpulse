ALTER TABLE entries
ADD COLUMN IF NOT EXISTS normalized_search_document TEXT NOT NULL DEFAULT '';

UPDATE entries
SET normalized_search_document = LOWER(
  TRANSLATE(
    COALESCE(title, '') || ' ' || COALESCE(content, ''),
    'ÁÀÂÄÃÅáàâäãåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'
  )
)
WHERE normalized_search_document = '';

CREATE INDEX IF NOT EXISTS idx_entries_normalized_search_document_tsv
ON entries USING GIN (to_tsvector('simple', normalized_search_document));

CREATE INDEX IF NOT EXISTS idx_entries_feed_published_id
ON entries (feed_id, published_at DESC, id DESC);

-- Manual rollback guide (framework currently applies only "up" migrations):
-- DROP INDEX IF EXISTS idx_entries_feed_published_id;
-- DROP INDEX IF EXISTS idx_entries_normalized_search_document_tsv;
-- ALTER TABLE entries DROP COLUMN IF EXISTS normalized_search_document;
