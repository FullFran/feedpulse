# ADR 0003 — One alert per article, keyed on a canonical link

**Status:** accepted · **Applies to:** migrations 0012, 0013, 0018; `src/modules/alerts/domain/canonical-article-link.ts`; `AlertsRepository.createForEntryWithRules`

## Context

The original model created one alert per `(entry_id, rule_id)` pair. Two failure modes
followed, and both were visible to users as spam:

1. **Several rules, one article.** An article matching three rules produced three alerts and
   three notifications for what a human reads as one story.
2. **Several feeds, one article.** The same article syndicated through five feeds — each one
   appending its own campaign parameters to the link — produced five distinct entries and
   therefore five alerts.

## Decision

An alert is keyed on the **article**, per tenant, not on the rule.

**The key.** `canonicalArticleLink` (`src/modules/alerts/domain/canonical-article-link.ts`)
normalizes the entry link:

- Removes tracking parameters from an explicit denylist (`utm_*`, `fbclid`, `gclid`,
  `mc_cid`, `mc_eid`, `ref`, `ref_src`, `at_medium`, `at_campaign`, `__twitter_impression`).
  Dropping the whole query string was rejected: it would merge `?page=2` with `?page=3` and
  `?id=123` with `?id=456`, which are different articles on many CMSs.
- Sorts the surviving parameters, so parameter order stops producing duplicates.
- Drops default ports and the fragment.
- Does **not** strip `www.` and does **not** upgrade `http` to `https`. Both are routinely
  different origins serving different content.

The asymmetry is deliberate throughout: collapsing two different articles is a correctness
bug, showing the same article twice is a nuisance. The rules only ever collapse what is
provably the same URL.

**The constraint.** Migration 0018 creates

```sql
CREATE UNIQUE INDEX idx_alerts_tenant_dedupe_key_unique
ON alerts (tenant_id, COALESCE(canonical_link, 'entry:' || entry_id::text));
```

The `COALESCE` fallback covers entries with no usable link. A partial index
(`WHERE canonical_link IS NOT NULL`, which migration 0013 used) does not constrain `NULL`s
at all, so those entries duplicated freely.

**The write.** One statement handles the whole batch:

```sql
INSERT INTO alerts (tenant_id, entry_id, rule_id, matched_rules, canonical_link)
SELECT … FROM unnest($1::text[], $2::bigint[], $3::int[], $4::text[], $5::text[]) AS v(…)
ON CONFLICT (tenant_id, (COALESCE(canonical_link, 'entry:' || entry_id::text)))
DO UPDATE SET matched_rules = ARRAY(
  SELECT DISTINCT unnest(alerts.matched_rules || EXCLUDED.matched_rules) ORDER BY 1
)
RETURNING id::text AS id, entry_id::text AS entry_id, rule_id, (xmax = 0) AS inserted
```

`xmax = 0` is true only for tuples **this statement inserted**. That single flag is what
separates "genuinely new alert — deliver it, count it" from "existing alert that merely
gained another matching rule — do not re-deliver". A read-then-write would have been racy;
a plain `DO NOTHING` would have lost the new rule.

The `ON CONFLICT` expression must stay byte-for-byte identical to the index definition or
PostgreSQL refuses the statement at runtime. Rules that match are appended to
`matched_rules` rather than overwriting it, because a blind `SET` could lose a concurrently
appended rule.

## The parity requirement

Migration 0018 backfills `canonical_link` for pre-existing rows using `normalize_alert_link`,
a plpgsql mirror of the TypeScript function. If the two disagree by a single byte, a
backfilled row and a freshly ingested row for the _same_ article stop colliding and the
tenant gets exactly the duplicate the migration exists to prevent.

That requirement forced one concrete tradeoff. The TypeScript side used to round-trip the
query through `URLSearchParams`, whose WHATWG _form_ serializer rewrites `%20`→`+`,
`%41`→`A`, `%2Ab`→`a*b`. plpgsql cannot reproduce that, and reproducing the WHATWG
special-query percent-encode set in SQL is not a short list of punctuation — it is every
code point above U+007E plus the C0 controls. Chasing it character by character is
unwinnable.

The query is therefore read from the **original input string**, before any URL parser
touches it, and canonicalized without percent-decoding. The cost is that `%2f` and `%2F`
count as different keys; that is acceptable because a single feed escapes its own links
consistently. `test/canonical-link-parity.integration-spec.ts` asserts the two
implementations agree against a real PostgreSQL.

## Consequences

**Good.** One notification per article per tenant. `matched_rules` carries the full set, so
the alert can still explain _why_ it fired. The write is a single atomic statement, correct
under concurrent workers.

**Bad.** The dedupe key is a URL, so a publisher that changes an article's URL produces a
second alert. Entries sharing a dedupe key must be collapsed in application code before the
statement runs, because PostgreSQL rejects an `ON CONFLICT DO UPDATE` that would touch the
same row twice in one statement. And the suite covering this cannot run on the in-memory
emulator at all: `unnest` and the `xmax` system column both require a real PostgreSQL.
