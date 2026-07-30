# ADR 0001 — Raw SQL migrations instead of an ORM

**Status:** accepted · **Applies to:** `db/migrations/`, `src/infrastructure/persistence/migrations.ts`, every `*.repository.ts`

## Context

The schema is small (twelve tables) but leans on PostgreSQL features that generic tooling
either cannot express or expresses badly:

- Partial unique indexes (`WHERE status = 'active'`, `WHERE revoked_at IS NULL`,
  `WHERE claimed_at IS NOT NULL`).
- A unique index over an **expression**, `COALESCE(canonical_link, 'entry:' || entry_id::text)`,
  which an `ON CONFLICT` clause then has to infer byte for byte.
- A `STORED GENERATED` column driven by a custom `IMMUTABLE` SQL function.
- `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` as the feed claim.
- `RETURNING (xmax = 0) AS inserted` to distinguish an inserted row from an updated one.

Every one of those is load-bearing, and every one is the kind of thing an ORM makes you
write as an escape hatch anyway.

## Decision

Persistence is raw SQL through `pg`. Migrations are plain `.sql` files applied in filename
order by a purpose-built runner (`src/infrastructure/persistence/migrations.ts`), invoked
explicitly by `npm run migrate` and never at application boot.

The runner supplies the three things a hand-rolled migration story usually lacks:

1. A session-level `pg_advisory_lock` on a dedicated connection, so concurrent replicas
   cannot execute the same DDL. The Compose `api` service runs `migrate` before starting,
   and that is a real race with more than one replica.
2. A SHA-256 checksum per applied file. Editing a migration that has already run fails the
   next deployment loudly, and the error names the next free version number.
3. `INSERT … ON CONFLICT (version) DO NOTHING RETURNING version` as the "already applied?"
   test, so the runner stays correct even if the lock is bypassed.

## Consequences

**Good.** The SQL in the repository is the SQL that runs — no generated statement to read
back. Query plans are reviewable in a pull request. There is no ORM version to keep in step
with the PostgreSQL version, and no ORM in the production dependency tree.

**Bad.** Column-to-field mapping is written by hand in every repository, which is
boilerplate and a place typos can hide. There is no automatic `down` migration; rollback is
a new forward migration. Refactoring a column name means finding every string that mentions
it.

**Mitigations.** `test/schema-parity.integration-spec.ts` diffs the test schema against the
real migrations so drift cannot appear silently, and `test/migrations.integration-spec.ts`
applies `db/migrations` to a throwaway database from empty on every CI run.

## Alternatives considered

- **TypeORM / Prisma migrations.** Rejected: the expression index and the `ON CONFLICT`
  inference over it would have to be raw SQL regardless, so the tool would own the easy 80%
  and leave the load-bearing 20% outside its model — the worst split.
- **A migration CLI (`node-pg-migrate`, `dbmate`) with raw SQL files.** Closer, and a
  reasonable choice. Rejected because the advisory lock, the checksum gate and the
  race-safe claim are roughly 200 lines that are exercised by their own test suite, and
  adding a dependency to get them would not have removed a single line of SQL.
