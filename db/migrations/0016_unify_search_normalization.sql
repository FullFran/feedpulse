-- Migration 0016: one search-text normalizer, shared by TypeScript and Postgres.
--
-- Four implementations of "normalize this text for keyword matching" had drifted
-- apart: the ingestion matcher collapsed whitespace, the entries repository did
-- not (and it is the one that wrote normalized_search_document), migration 0007
-- hardcoded a TRANSLATE over 52 Latin-1 characters and handled neither Greek nor
-- Cyrillic, and the rule DTO only trimmed. A keyword could therefore match in
-- memory and miss in SQL.
--
-- normalized_search_document becomes a STORED GENERATED column so the value can
-- no longer drift from its source row: Postgres recomputes it on every write and
-- backfills every existing row during this migration. src/shared/text/
-- normalize-search-text.ts implements exactly the same steps and must be kept in
-- sync with feedpulse_normalize_search_text below.
--
-- Requirements: PostgreSQL 13+ (for normalize()) and a UTF8 database encoding
-- (for the U+0300-U+036F escape). No extension is needed; unaccent is
-- deliberately avoided because it is not IMMUTABLE and cannot back a generated
-- column.

CREATE OR REPLACE FUNCTION feedpulse_normalize_search_text(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT btrim(
    regexp_replace(
      lower(
        regexp_replace(
          normalize(COALESCE(input, ''), NFD),
          E'[\u0300-\u036F]',
          '',
          'g'
        )
      ),
      '\s+',
      ' ',
      'g'
    )
  )
$$;

COMMENT ON FUNCTION feedpulse_normalize_search_text(TEXT) IS
  'NFD, strip combining diacritics, lowercase, collapse whitespace, trim. Mirror of src/shared/text/normalize-search-text.ts.';

-- The GIN index depends on the column, so it has to be rebuilt around the
-- conversion. A stored generated column cannot be produced with ALTER COLUMN;
-- dropping and re-adding is the supported path and rewrites the table once.
DROP INDEX IF EXISTS idx_entries_normalized_search_document_tsv;

ALTER TABLE entries DROP COLUMN IF EXISTS normalized_search_document;

ALTER TABLE entries
ADD COLUMN normalized_search_document TEXT
GENERATED ALWAYS AS (
  feedpulse_normalize_search_text(COALESCE(title, '') || ' ' || COALESCE(content, ''))
) STORED;

CREATE INDEX IF NOT EXISTS idx_entries_normalized_search_document_tsv
ON entries USING GIN (to_tsvector('simple', normalized_search_document));
