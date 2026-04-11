ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS canonical_link TEXT;

CREATE OR REPLACE FUNCTION normalize_alert_link(input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate TEXT;
  parts TEXT[];
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  candidate := btrim(split_part(input, '#', 1));
  IF candidate = '' THEN
    RETURN NULL;
  END IF;

  parts := regexp_match(candidate, '^(https?://)([^/?#]+)(.*)$');
  IF parts IS NOT NULL THEN
    candidate := lower(parts[1]) || lower(parts[2]) || parts[3];
  END IF;

  IF candidate !~ '^https?://[^/?#]+/$' THEN
    candidate := regexp_replace(candidate, '/+$', '');
  END IF;

  IF candidate = '' THEN
    RETURN NULL;
  END IF;

  RETURN candidate;
END;
$$;

UPDATE alerts a
SET canonical_link = normalize_alert_link(e.link)
FROM entries e
WHERE a.entry_id = e.id
  AND (a.canonical_link IS NULL OR btrim(a.canonical_link) = '');

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, rule_id, canonical_link
           ORDER BY created_at ASC, id ASC
         ) AS row_num
  FROM alerts
  WHERE canonical_link IS NOT NULL
)
DELETE FROM alerts a
USING ranked r
WHERE a.id = r.id
  AND r.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_tenant_rule_canonical_link_unique
ON alerts (tenant_id, rule_id, canonical_link)
WHERE canonical_link IS NOT NULL;

DROP FUNCTION IF EXISTS normalize_alert_link(TEXT);
