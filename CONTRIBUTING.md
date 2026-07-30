# Contributing to FeedPulse

Thanks for taking the time. This document covers local setup, the checks a pull
request has to pass, and the two conventions that are easy to get wrong:
commit messages and database migrations.

Everything in this repository — code, comments, commit messages, documentation,
issues and pull requests — is written in English.

## Local setup

**Prerequisites:** Node.js as pinned in [`.nvmrc`](.nvmrc), npm 10 or newer, and
Docker with the Compose plugin.

```bash
nvm use                 # or install the version in .nvmrc by hand
npm ci
cp .env.example .env
```

Start the backing services. The Compose file exposes PostgreSQL on host port
`55432` and Redis on `56379` by default (override with `POSTGRES_HOST_PORT` and
`REDIS_HOST_PORT`):

```bash
docker compose up -d postgres redis
npm run migrate
```

Issue yourself an API key. The plaintext key is printed once and is not
recoverable afterwards — only its SHA-256 hash is stored:

```bash
npm run apikey:create -- --tenant local --label "dev laptop"
```

Run the three runtimes in separate terminals:

```bash
npm run start:api
npm run start:scheduler
npm run start:worker
```

## Running the tests

```bash
npm test
```

Suites that need a real PostgreSQL instance skip themselves when
`TEST_DATABASE_URL` is unset, so a clone without Docker still gets a green run —
it simply covers less. To run them, point `TEST_DATABASE_URL` at a **throwaway**
database:

```bash
docker run --rm -d --name feedpulse-test-db \
  -p 55433:5432 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=feedpulse_test \
  postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55433/feedpulse_test npm test
```

Those suites create, truncate and drop schema objects. Never point
`TEST_DATABASE_URL` at a database whose contents you care about.

The suites are also split, if you want a faster loop:

```bash
npm run test:unit
npm run test:integration
```

## Before you open a pull request

Run the same gates CI runs, in this order:

```bash
npm run lint          # ESLint flat config, type-aware — must report no problems
npm run format:check  # Prettier — no diff allowed
npm run typecheck     # tsc --noEmit
npm test              # with TEST_DATABASE_URL set, ideally
npm run build         # emits dist/, the artifact the container runs
```

`npm run lint:fix` and `npm run format` fix most of what the first two report.

If your change touches the `Dockerfile`, either Compose file, a runtime entry
point under `src/main/`, or a migration, also run the full stack smoke test. It
builds the image and exercises a live stack, so it takes minutes rather than
seconds:

```bash
npm run smoke:ci
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), with the
standard type set:

`feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`

```
fix: revalidate every redirect hop before fetching
```

History contains one `refine:` commit. That is not a type to copy — use
`refactor:` instead. Branches follow the same vocabulary: `feat/short-slug`,
`fix/short-slug`, `chore/short-slug`.

Keep the subject in the imperative mood, under about 72 characters, and with no
trailing period. Put the reasoning in the body: the repository's comments and
migration headers explain _why_, and commit messages are held to the same bar.

## Database migrations

SQL migrations live in `db/migrations/` and are applied in filename order by
`npm run migrate`. A new migration continues the sequence — at the time of
writing the next free name is `0022_short_description.sql`.

**Migrations are append-only.** Once a file has been applied it must never be
edited, not even to fix a typo in a comment. The runner records a SHA-256
checksum of every applied file and refuses to continue if one changed:

```
Migration "0019_dead_letter_jobs.sql" has already been applied but its content
changed (recorded sha256 <recorded>, current sha256 <current>). Migrations are
append-only: never edit a migration that has already run. Revert
"0019_dead_letter_jobs.sql" to its applied content and add your change as
"0022_<describe_your_change>.sql" instead.
```

If you hit that error, do exactly what it says: restore the file to its applied
content and put the change in a new migration.

Two more rules the existing migrations follow:

- **Write a header comment explaining why.** Every migration in this repository opens with the problem it solves and the consequences of applying it. Look at `0018_alerts_canonical_relink_and_index_cleanup.sql` for the expected level of detail, including its explicit `DESTRUCTIVE` warning.
- **Keep SQL and TypeScript in sync when they encode the same rule.** `feedpulse_normalize_search_text()` (migration `0016`) and `src/shared/text/normalize-search-text.ts` implement the same normalizer, and `test/schema-parity.integration-spec.ts` and `test/canonical-link-parity.integration-spec.ts` exist to catch drift. If you change one side, change the other and keep the parity test passing.

## Code conventions

- The layout follows Clean/Hexagonal architecture: `src/modules/*` holds domain and application code with its HTTP adapters, `src/infrastructure/*` holds PostgreSQL and BullMQ adapters, and `src/shared/*` holds config, logging and HTTP cross-cutting concerns. Domain code does not import infrastructure.
- All outbound HTTP to a URL that came from stored data goes through `safeFetch` in `src/shared/http/safe-fetch.ts`. Calling the global `fetch` directly for such a URL reintroduces the SSRF hole that module exists to close.
- Comments explain _why_, not _what_. A comment restating the line below it will be asked about in review.
- Do not weaken, skip or delete a passing test to make a change land.
- FeedPulse is a deployable application, not a library. It is MIT licensed and `package.json` carries the full public metadata (`name`, `license`, `repository`, `bugs`, `homepage`), but nothing is published to the npm registry — install it by cloning the repository, not with `npm install feedpulse`.

## Reporting problems

- Bugs and feature ideas: use the [issue templates](https://github.com/FullFran/feedpulse/issues/new/choose).
- Security vulnerabilities: **do not open an issue.** Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
