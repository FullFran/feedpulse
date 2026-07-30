-- Migration 0017: recompute entries.content_hash under the link|guid|published_at formula.
--
-- The hash used to be sha256(title|link|published_at). Publishers routinely
-- revise a headline after publication, so the same article came back with a new
-- hash, was inserted as a new entry, and produced a second alert. Article
-- identity is now link + guid + publication instant.
--
-- Without this backfill every entry ingested before the change would rehash on
-- its next appearance in the feed and upgraders would get a burst of duplicate
-- alerts on the first poll after deploy.
--
-- published_at is rendered with the same shape as JavaScript's Date#toISOString
-- (millisecond precision, UTC, trailing Z) because that is exactly what
-- ProcessFeedJobUseCase hashes; see normalizePublishedAt() there.
--
-- Non-destructive: rows whose new hash would collide with a sibling in the same
-- feed keep their old hash instead of being deleted. Those are the legacy
-- duplicates this change prevents from being created again; removing them would
-- cascade into alerts and is out of scope for an automatic migration.

CREATE OR REPLACE FUNCTION feedpulse_entry_content_hash(
  link TEXT,
  guid TEXT,
  published_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT encode(
    sha256(
      convert_to(
        COALESCE(link, '')
          || '|' || COALESCE(guid, '')
          || '|' || COALESCE(
               to_char(
                 date_trunc('milliseconds', published_at) AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ),
               ''
             ),
        'UTF8'
      )
    ),
    'hex'
  )
$$;

COMMENT ON FUNCTION feedpulse_entry_content_hash(TEXT, TEXT, TIMESTAMPTZ) IS
  'sha256 of link|guid|publishedAtIso. Mirror of the content hash in ProcessFeedJobUseCase.';

-- Batched by primary key so the rewrite does not build one enormous snapshot.
-- The whole migration still runs in a single transaction (the runner wraps each
-- file), the batching only bounds peak memory and WAL churn per statement.
DO $$
DECLARE
  batch_start BIGINT := 0;
  batch_size  BIGINT := 5000;
  max_id      BIGINT;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO max_id FROM entries;

  WHILE batch_start <= max_id LOOP
    WITH candidate AS (
      SELECT e.id,
             e.feed_id,
             feedpulse_entry_content_hash(e.link, e.guid, e.published_at) AS new_hash
      FROM entries e
      WHERE e.id > batch_start
        AND e.id <= batch_start + batch_size
        AND e.content_hash IS DISTINCT FROM feedpulse_entry_content_hash(e.link, e.guid, e.published_at)
    ),
    deduped AS (
      SELECT DISTINCT ON (feed_id, new_hash) id, feed_id, new_hash
      FROM candidate
      ORDER BY feed_id, new_hash, id
    ),
    applicable AS (
      SELECT d.id, d.new_hash
      FROM deduped d
      WHERE NOT EXISTS (
        SELECT 1
        FROM entries x
        WHERE x.feed_id = d.feed_id
          AND x.content_hash = d.new_hash
          AND x.id <> d.id
      )
    )
    UPDATE entries e
    SET content_hash = a.new_hash
    FROM applicable a
    WHERE e.id = a.id;

    batch_start := batch_start + batch_size;
  END LOOP;
END
$$;
