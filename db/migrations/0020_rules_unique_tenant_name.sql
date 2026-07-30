-- Migration 0020: one rule name per tenant.
--
-- WHY: `rules` has carried a `(tenant_id, name)` lookup since 0006 but never a
-- uniqueness rule behind it. `RulesRepository.upsertByName` — the path every OPML
-- import and every seeded rule goes through — is therefore a read-then-write:
-- two concurrent imports both observe "no rule with that name" and both insert,
-- leaving a tenant with two rules that claim to be the same rule. Batch rule
-- creation (`POST /api/v1/rules/batch`) needs the same guarantee, expressed as
-- `ON CONFLICT (tenant_id, name)`, so that a batch can never overwrite a rule the
-- caller did not intend to touch.
--
-- DESTRUCTIVE-ADJACENT: existing duplicates have to be resolved before the index
-- can be created. A rule row is user-authored configuration, not derived data, so
-- nothing is deleted here. The OLDEST row of each `(tenant_id, name)` group keeps
-- the name — it is the one alerts and habits already point at — and every later
-- row is RENAMED by appending ` (2)`, ` (3)`, ... The suffix search skips names
-- that are already taken, so a tenant holding "Evictions", "Evictions" and
-- "Evictions (2)" ends up with "Evictions", "Evictions (3)" and "Evictions (2)"
-- rather than a second collision.
--
-- The whole file runs inside the single transaction the migration runner opens
-- per file: either every rename lands and the index exists, or nothing changed.

DO $$
DECLARE
  loser      RECORD;
  suffix_n   INT;
  suffix     TEXT;
  base_name  TEXT;
  candidate  TEXT;
BEGIN
  FOR loser IN
    SELECT ranked.id, ranked.tenant_id, ranked.name
      FROM (
        SELECT id,
               tenant_id,
               name,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, name
                 ORDER BY created_at ASC, id ASC
               ) AS row_num
          FROM rules
      ) ranked
     WHERE ranked.row_num > 1
     ORDER BY ranked.tenant_id, ranked.name, ranked.id
  LOOP
    suffix_n := 2;

    LOOP
      suffix := ' (' || suffix_n || ')';
      base_name := loser.name;

      -- `CreateRuleDto`/`UpdateRuleDto` cap `name` at 120 characters. The column
      -- itself is unbounded TEXT, but a renamed rule that exceeded the API cap
      -- could never be edited again, so the base is trimmed to make room.
      IF length(base_name) + length(suffix) > 120 THEN
        base_name := left(base_name, 120 - length(suffix));
      END IF;

      candidate := base_name || suffix;

      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM rules taken
         WHERE taken.tenant_id = loser.tenant_id
           AND taken.name = candidate
      );

      suffix_n := suffix_n + 1;
    END LOOP;

    UPDATE rules
       SET name = candidate,
           updated_at = NOW()
     WHERE id = loser.id;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_tenant_name_unique
ON rules (tenant_id, name);
