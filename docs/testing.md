# Testing

How the suite is organised, where each kind of test belongs, and — the part that costs
contributors the most time to rediscover — exactly what the in-memory PostgreSQL emulator
can and cannot do.

## Commands

```bash
npm test                  # both projects, serially — the full suite
npm run test:unit         # pure unit specs only, parallel workers
npm run test:integration  # Nest bootstrap / pg-mem / real PostgreSQL, serially
npm run test:cov          # full suite with coverage thresholds enforced
```

`npm test` runs `--runInBand` on purpose: several suites point at the same throwaway
database through `TEST_DATABASE_URL` and would otherwise race each other's schema resets.

## Naming convention

The file name decides which Jest project a spec lands in. There is no other switch.

| Pattern                 | Project       | May use                                                      |
| ----------------------- | ------------- | ------------------------------------------------------------ |
| `*.spec.ts`             | `unit`        | Nothing external. No pg-mem, no Nest container, no database. |
| `*.integration-spec.ts` | `integration` | pg-mem, a Nest `TestingModule`, or a real PostgreSQL.        |

`jest.unit.config.ts` matches `.*(?<!integration-)spec\.ts$` — the negative lookbehind is
what keeps the two disjoint, so every spec runs exactly once across the two projects.

`HEAVY_SPEC_PATHS` in `jest.unit.config.ts` lists four files that carry a `.spec.ts` name
but bootstrap a container or a pg-mem database. They are routed to the integration project
until they are renamed. **Do not add entries to that list** — name a new heavy spec
`*.integration-spec.ts` instead.

Both projects transpile with `ts-jest` in `isolatedModules` mode and `diagnostics: false`.
That is what takes the unit run from roughly twelve seconds to under four, and it is only
safe because type errors are still caught by `npm run typecheck` in the same CI job. The two
must stay together.

## The harness

Everything shared lives in `test/support/` and is excluded from both projects' test
matching.

| File                | Purpose                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg-mem.ts`         | The **only** place allowed to instantiate pg-mem. Creates the engine, registers function shims, returns a `pg`-compatible pool.                                |
| `schema.ts`         | The single source of truth for the pg-mem schema, reproducing the end state of `db/migrations/0001..0021`, plus `KNOWN_SCHEMA_DIVERGENCES`.                    |
| `builders.ts`       | Fixture builders for domain objects.                                                                                                                           |
| `fakes.ts`          | In-memory doubles for the queue and fetcher ports.                                                                                                             |
| `http.ts`           | Typed readers for supertest bodies — `dataOf`, `itemsOf`, `paginatedBody`, `errorBody` — that funnel supertest's `any` through `unknown` in one audited place. |
| `expect-defined.ts` | `expectDefined(value, what)` — narrows the `T \| undefined` that `noUncheckedIndexedAccess` gives every indexed read. Used by 25 spec files.                   |

Before `schema.ts` existed, four suites each hand-wrote their own subset of the schema and
they had already drifted: one still declared a constraint migration 0013 drops, another kept
an index migration 0018 drops, and none of them had `feeds.claimed_at` from migration 0015.
A repository could therefore pass its tests against a schema production had not had for
months. `test/schema-parity.integration-spec.ts` now diffs the emulator schema against the
real migrations and fails on any undeclared difference.

`tsconfig.json` sets `noUncheckedIndexedAccess`, so `rows[0]` is typed `T | undefined` in
tests as well as in `src/`. Reach for `expectDefined(rows[0], 'first row')` rather than a
`!` assertion: it fails with `Expected first row to be defined, got undefined` instead of a
`TypeError` pointing at whichever property you happened to read next.

## Database-gated suites

Suites that need a real PostgreSQL guard themselves with

```ts
const describeWithDatabase = process.env.TEST_DATABASE_URL ? describe : describe.skip;
```

and **skip silently** when it is unset. A green `npm test` on a machine without a database
is therefore a weaker signal than it looks: it leaves the migration runner, schema parity,
tenant isolation, the canonical-link dedupe and the feed claim/sweep unexercised.

```bash
docker run -d --rm --name fp-test --network host \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feedpulse_test -e PGPORT=55999 \
  postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55999/feedpulse_test npm test

docker rm -f fp-test
```

Two constraints on that URL:

- The target schema is **wiped** (`DROP SCHEMA public CASCADE`) on every run. Never point it
  at anything real. The suites deliberately refuse to fall back to `DATABASE_URL` for this
  reason.
- The role needs `CREATE DATABASE` and `DROP DATABASE`.
  `test/migrations.integration-spec.ts` provisions a throwaway database per run so it can
  apply `db/migrations` from empty without touching the schema the other suites share. The
  default `postgres` superuser satisfies this.

CI provisions a `postgres:16-alpine` service and exports `TEST_DATABASE_URL`, so these
suites do run on every pull request.

## pg-mem capability boundary

**Version: pg-mem 3.0.14** (`package.json` declares `^3.0.5`; the resolved version in
`package-lock.json` is what these results were measured against). The table below was
produced by executing each statement against a fresh `newDb({ autoCreateForeignKeyIndices:
true, noAstCoverageCheck: true })` engine — the same options `test/support/pg-mem.ts` uses.

**Re-probe this table whenever pg-mem is upgraded.** A capability list that is not
re-measured becomes confidently wrong, which is worse than having none.

### Supported

| Feature                                               | Notes                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial unique indexes                                | Actually **enforced**, not just parsed.                                                                                                           |
| `CHECK` constraints                                   | Enforced.                                                                                                                                         |
| `ON CONFLICT (col) DO NOTHING`                        |                                                                                                                                                   |
| `ON CONFLICT (col) DO UPDATE SET … EXCLUDED.…`        |                                                                                                                                                   |
| `ON CONFLICT` inferred from an **expression** index   | e.g. `ON CONFLICT (COALESCE(a, 'x:' \|\| b::text))`.                                                                                              |
| `TEXT[]` and `INTEGER[]` columns, `ARRAY[…]` literals |                                                                                                                                                   |
| Array subscripting (`a[1]`)                           |                                                                                                                                                   |
| `GENERATED ALWAYS AS (…) STORED`                      | How `entries.normalized_search_document` is emulated.                                                                                             |
| `GREATEST`, `LIKE`, `ILIKE`                           |                                                                                                                                                   |
| `ORDER BY … NULLS LAST`, `CASE` in `ORDER BY`         |                                                                                                                                                   |
| `COUNT(*)::text`                                      |                                                                                                                                                   |
| `NOW()` on `TIMESTAMPTZ`, and `NOW() - INTERVAL '…'`  |                                                                                                                                                   |
| `information_schema.tables`                           | Used by `test/schema-parity.integration-spec.ts` and the pg-mem harness.                                                                          |
| `WITH … SELECT` (CTE in a query)                      |                                                                                                                                                   |
| `RETURNING`                                           |                                                                                                                                                   |
| `jsonb` columns                                       |                                                                                                                                                   |
| `CREATE INDEX … USING btree (col DESC)`               |                                                                                                                                                   |
| `FOR UPDATE SKIP LOCKED`                              | **Parses and returns rows, but there is no row locking behind it.** It proves the statement is syntactically valid and nothing about concurrency. |

### Not supported

| Feature                                   | Consequence                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `unnest()`                                | `AlertsRepository.createForEntryWithRules` needs it; that suite needs real Postgres. |
| The `xmax` system column                  | Same statement. `(xmax = 0) AS inserted` cannot be emulated at all.                  |
| Window functions (`… OVER (…)`)           | Used by several migrations to de-duplicate before adding a unique index.             |
| `DELETE … USING …`                        | Both with and without a CTE.                                                         |
| plpgsql function bodies                   | `LANGUAGE sql` bodies **are** supported; `LANGUAGE plpgsql` is not.                  |
| `translate()`                             | Shimmed in `test/support/pg-mem.ts`.                                                 |
| `regexp_replace()`, `regexp_match()`      | Shimmed.                                                                             |
| `split_part()`                            | Shimmed.                                                                             |
| `to_tsvector()` and GIN full-text indexes | Shimmed to the identity function purely so the DDL parses; it indexes nothing.       |
| `normalize(x, NFD)`                       | Why `feedpulse_normalize_search_text` is bound to the TypeScript normalizer instead. |
| `sha256()`, `convert_to()`, `encode()`    | Why `feedpulse_entry_content_hash` has no emulator equivalent.                       |
| `pg_try_advisory_lock()`                  | The migration runner's lock cannot be exercised in the emulator.                     |
| `gen_random_uuid()`, `random()`           | Shimmed where a suite needs them.                                                    |

"Shimmed" means `test/support/pg-mem.ts` registers a minimal JavaScript reimplementation —
correct for the inputs this schema and these suites produce, and nothing more. It is not a
general PostgreSQL implementation and must not be treated as one.

### Why the migration files need a real PostgreSQL

`db/migrations` is never applied to pg-mem. These files use SQL the emulator does not
implement:

| Migration | Unsupported SQL it uses                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| 0004      | `to_tsvector`, `translate`                                                                     |
| 0007      | `translate`                                                                                    |
| 0012      | `LANGUAGE plpgsql`, window functions, `regexp_match`, `regexp_replace`, `split_part`           |
| 0013      | window functions                                                                               |
| 0016      | `normalize(…, NFD)`, `regexp_replace`, `to_tsvector`                                           |
| 0017      | `sha256`, `convert_to`                                                                         |
| 0018      | `LANGUAGE plpgsql`, window functions, `unnest`, `regexp_match`, `regexp_replace`, `split_part` |
| 0020      | window functions                                                                               |
| 0021      | `sha256`                                                                                       |

That is why `test/support/schema.ts` reproduces the _end state_ of the migrations as
emulator-compatible DDL rather than replaying the files, and why `schema-parity` exists to
keep the two honest.

### Other emulator differences worth remembering

- **BIGINT type.** `pg` returns `bigint` as a **string** (which is why ids are typed
  `string` across the domain); pg-mem returns a JavaScript **number**. Compare with
  `String(id) === '42'` in pg-mem suites.
- **`information_schema.columns.is_nullable`** reports `NO` for every column, including
  nullable ones, so the parity spec compares names and types only.
- **Column order** differs: the migrations append columns with `ALTER TABLE ADD COLUMN`, the
  emulator declares them inline. Not observable through any query the application makes.

## Where to put a new test

| You are testing…                                             | Write…                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| A pure function, a domain rule, a DTO transform              | `*.spec.ts` with no I/O at all.                                                                                 |
| A use case with a port                                       | `*.spec.ts` using the fakes in `test/support/fakes.ts`.                                                         |
| A repository's SQL against emulator-supported features       | `*.integration-spec.ts` with `createPgMemPool()`.                                                               |
| SQL that touches anything in the "not supported" table above | `*.integration-spec.ts` gated on `TEST_DATABASE_URL`.                                                           |
| An HTTP contract end to end                                  | `*.integration-spec.ts` with a Nest `TestingModule` and supertest, using the readers in `test/support/http.ts`. |

## Coverage

Thresholds live in the root `jest.config.ts` and are a **ratchet, never a target**. The
floor is set just under the run _without_ `TEST_DATABASE_URL`, because that is the weakest
run anyone can perform. Both runs were re-measured on 2026-07-30:

|                  | statements | branches | functions | lines |
| ---------------- | ---------: | -------: | --------: | ----: |
| Without database |      79.28 |    67.05 |     70.28 | 78.70 |
| With database    |      85.70 |    71.74 |     81.15 | 85.26 |

Raise the thresholds when coverage rises. Never lower them to make a build pass.

## Beyond Jest

| Command                            | What it proves                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run smoke:ci`                 | The full Docker stack boots, migrates, ingests and delivers. See [`local-smoke.md`](./local-smoke.md).       |
| `npm run benchmark:stage:100:safe` | The ingestion path under load, one command, self-cleaning. See [`local-benchmark.md`](./local-benchmark.md). |
