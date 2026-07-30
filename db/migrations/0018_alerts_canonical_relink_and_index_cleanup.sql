-- Migration 0018: recanonicalize alert links, dedupe including NULL links, and
-- replace the two partial uniqueness rules with one total rule.
--
-- DESTRUCTIVE: this migration DELETES duplicate alert rows. Review it as such.
-- It runs inside the single transaction the migration runner opens per file, so
-- it either fully applies or fully rolls back. Pending Telegram digest items are
-- repointed at the surviving alert before the delete, so queued notifications
-- are not silently dropped.
--
-- Three problems are addressed:
--   1. canonical_link was written by an older canonicalizer that kept tracking
--      parameters, so the same article syndicated with different utm_* tags
--      produced several alerts. It is recomputed with the current rules.
--   2. Alerts whose canonical_link is NULL were never constrained: the 0013
--      unique index is partial (WHERE canonical_link IS NOT NULL), so entries
--      without a usable link could alert repeatedly. The new index keys on
--      COALESCE(canonical_link, 'entry:' || entry_id::text), which degrades to
--      per-entry dedupe instead of no dedupe at all.
--   3. idx_alerts_tenant_rule_canonical_link_unique from 0012 allowed one alert
--      per (tenant, rule, link); 0013 replaced that model with one alert per
--      (tenant, link) carrying a matched_rules array. Both are strictly
--      subsumed by the new index and only cost write throughput.
--
-- The ON CONFLICT clause in AlertsRepository.createForEntryWithRules infers the
-- index created at the bottom of this file. Its expression must stay identical
-- on both sides or Postgres rejects the statement at runtime.

CREATE OR REPLACE FUNCTION feedpulse_canonicalize_article_link(input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate   TEXT;
  raw_query   TEXT := '';
  query_start INT;
  parts       TEXT[];
  scheme      TEXT := '';
  authority   TEXT := '';
  path_part   TEXT := '';
  kept_query  TEXT;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  candidate := btrim(split_part(input, '#', 1));
  IF candidate = '' THEN
    RETURN NULL;
  END IF;

  query_start := position('?' IN candidate);
  IF query_start > 0 THEN
    raw_query := substring(candidate FROM query_start + 1);
    candidate := substring(candidate FROM 1 FOR query_start - 1);
  END IF;

  parts := regexp_match(candidate, '^([a-zA-Z][a-zA-Z0-9+.-]*://)([^/]*)(.*)$');
  IF parts IS NOT NULL THEN
    scheme := lower(parts[1]);
    authority := lower(parts[2]);
    path_part := parts[3];
  ELSE
    parts := regexp_match(candidate, '^([^/]*)(.*)$');
    authority := lower(parts[1]);
    path_part := parts[2];
  END IF;

  IF scheme = 'http://' THEN
    authority := regexp_replace(authority, ':80$', '');
  ELSIF scheme = 'https://' THEN
    authority := regexp_replace(authority, ':443$', '');
  END IF;

  path_part := regexp_replace(path_part, '/{2,}', '/', 'g');
  IF path_part <> '/' THEN
    path_part := regexp_replace(path_part, '/+$', '');
  END IF;

  -- Byte-for-byte the same algorithm as `canonicalizeQuery` in
  -- src/modules/alerts/domain/canonical-article-link.ts: split on '&', drop the
  -- empty and the tracking pairs, apply the WHATWG special-query escapes plus
  -- '+' -> '%20', sort the RAW pair strings, join with '&'. TRADEOFF, deliberate:
  -- nothing percent-DECODES or re-encodes, so '%2f' and '%2F' are different keys.
  -- Acceptable (one feed escapes its own links consistently) and the only form in
  -- which this and the TypeScript can be PROVEN identical -- that side used to
  -- call URLSearchParams, a WHATWG *form* serializer ('%20' -> '+', '%41' -> 'A',
  -- '%2Ab' -> 'a*b') not maintainable to replicate here, so the row backfilled at
  -- step 2 and the row ingested later for the same article stopped colliding and
  -- the tenant got a duplicate alert. COLLATE "C" is load-bearing and verified,
  -- not assumed: on a glibc en_US.utf8 database bare `ORDER BY pair` yields
  -- a=1,aab=1,a_b=1,B=1,_z=1 while COLLATE "C" and JavaScript's Array#sort both
  -- yield B=1,_z=1,a=1,a_b=1,aab=1. test/canonical-link-parity.integration-spec.ts
  -- pins all of it.
  -- '+' -> '%20' is the ONLY rewrite, mirroring QUERY_ESCAPES on the TypeScript
  -- side. An earlier version also mapped ' " '' < >' here, trying to reproduce
  -- the WHATWG special-query encode set that URL parsing applies over there.
  -- That set also covers every code point above U+007E, so '?q=okupacion' (with
  -- the accent) still diverged: 'q=okupaci%C3%B3n' through the parser, raw here.
  -- The TypeScript now reads its query from the original input string, so the
  -- parser never rewrites it and there is nothing left for this side to match.
  SELECT string_agg(e.escaped, '&' ORDER BY e.escaped COLLATE "C")
  INTO kept_query
  FROM unnest(string_to_array(NULLIF(raw_query, ''), '&')) AS pair
  CROSS JOIN LATERAL (SELECT replace(pair, '+', '%20')) AS e(escaped)
  WHERE pair <> ''
    AND lower(split_part(pair, '=', 1)) NOT LIKE 'utm\_%'
    AND lower(split_part(pair, '=', 1)) NOT IN (
      'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
      'at_medium', 'at_campaign', '__twitter_impression'
    );

  candidate := scheme || authority || path_part;
  IF kept_query IS NOT NULL AND kept_query <> '' THEN
    candidate := candidate || '?' || kept_query;
  END IF;

  IF candidate = '' THEN
    RETURN NULL;
  END IF;

  RETURN candidate;
END;
$$;

-- Step 1: the old uniqueness rules have to go first. Recanonicalizing makes rows
-- collide on purpose, and the 0013 index would reject the UPDATE before the
-- dedupe below ever gets a chance to run.
DROP INDEX IF EXISTS idx_alerts_tenant_rule_canonical_link_unique;
DROP INDEX IF EXISTS idx_alerts_tenant_canonical_link_unique;

-- Step 2: recanonicalize from the entry link so historical rows use today's rules.
UPDATE alerts a
SET canonical_link = feedpulse_canonicalize_article_link(e.link)
FROM entries e
WHERE a.entry_id = e.id
  AND a.canonical_link IS DISTINCT FROM feedpulse_canonicalize_article_link(e.link);

-- Step 3: decide who survives each dedupe group. Oldest alert wins, so the row
-- that already carries delivery history is the one that stays.
CREATE TEMP TABLE alert_dedupe_plan ON COMMIT DROP AS
WITH ranked AS (
  SELECT id,
         tenant_id,
         entry_id,
         rule_id,
         matched_rules,
         COALESCE(canonical_link, 'entry:' || entry_id::text) AS dedupe_key,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, COALESCE(canonical_link, 'entry:' || entry_id::text)
           ORDER BY created_at ASC, id ASC
         ) AS row_num
  FROM alerts
)
SELECT r.id,
       r.tenant_id,
       r.dedupe_key,
       r.row_num,
       FIRST_VALUE(r.id) OVER (PARTITION BY r.tenant_id, r.dedupe_key ORDER BY r.row_num) AS survivor_id,
       CASE
         WHEN COALESCE(cardinality(r.matched_rules), 0) > 0 THEN r.matched_rules
         ELSE ARRAY[r.rule_id]
       END AS effective_rules
FROM ranked r;

-- Step 4: fold every duplicate's rules into the survivor, so recanonicalizing
-- never loses a rule that only the losing row knew about.
WITH unioned AS (
  SELECT p.survivor_id,
         array_agg(DISTINCT x.rule ORDER BY x.rule) AS union_rules
  FROM alert_dedupe_plan p
  CROSS JOIN LATERAL unnest(p.effective_rules) AS x(rule)
  GROUP BY p.survivor_id
)
UPDATE alerts a
SET matched_rules = u.union_rules
FROM unioned u
WHERE a.id = u.survivor_id
  AND a.matched_rules IS DISTINCT FROM u.union_rules;

-- Step 5: move pending digest items onto the survivor when the chat does not
-- already have one queued for it. The rest disappear with the delete below.
UPDATE telegram_digest_items t
SET alert_id = p.survivor_id
FROM alert_dedupe_plan p
WHERE t.alert_id = p.id
  AND p.row_num > 1
  AND NOT EXISTS (
    SELECT 1
    FROM telegram_digest_items existing
    WHERE existing.alert_id = p.survivor_id
      AND existing.chat_id = t.chat_id
  );

-- Step 6: delete the duplicates.
DELETE FROM alerts a
USING alert_dedupe_plan p
WHERE a.id = p.id
  AND p.row_num > 1;

-- Step 7: the one-alert-per-article rule, now total instead of partial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_tenant_dedupe_key_unique
ON alerts (tenant_id, (COALESCE(canonical_link, 'entry:' || entry_id::text)));

DROP FUNCTION IF EXISTS feedpulse_canonicalize_article_link(TEXT);
