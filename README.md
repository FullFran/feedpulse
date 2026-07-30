# FeedPulse

[![CI](https://github.com/FullFran/feedpulse/actions/workflows/ci.yml/badge.svg)](https://github.com/FullFran/feedpulse/actions/workflows/ci.yml)
[![Smoke](https://github.com/FullFran/feedpulse/actions/workflows/smoke.yml/badge.svg)](https://github.com/FullFran/feedpulse/actions/workflows/smoke.yml)
[![CodeQL](https://github.com/FullFran/feedpulse/actions/workflows/codeql.yml/badge.svg)](https://github.com/FullFran/feedpulse/actions/workflows/codeql.yml)
![Node](https://img.shields.io/badge/node-24-3c873a)
![License](https://img.shields.io/badge/license-MIT-blue)

FeedPulse is a multi-tenant RSS/Atom monitoring service. You register feeds and keyword
rules; it polls each feed on its own schedule, deduplicates entries, matches them against
your rules, and delivers **one alert per article** over webhook, email and Telegram. It is
built for the person who has to watch a few thousand sources for a handful of specific
phrases and wants that to be a background service with an API, not a browser tab — a news
desk, a compliance or market-intelligence team, or anyone self-hosting a monitoring stack
on a single VPS.

It is also a portfolio codebase, so it is written to be read: ports and adapters where a
seam earns its keep, raw SQL you can review, decisions recorded in
[ADRs](./docs/adr/), and every operational claim in this README verified against the code.

> The PostgreSQL database is still named `rss_monitor` and the smoke/benchmark Compose
> projects are still `rss-monitor-*`. That is the project's original name, kept because
> renaming it would orphan existing volumes for zero functional gain.

---

## Contents

- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Rules](#rules)
- [API](#api)
- [Performance](#performance)
- [Engineering notes](#engineering-notes)
- [Testing](#testing)
- [Quality gates](#quality-gates)
- [Roadmap and known limits](#roadmap-and-known-limits)
- [Documentation](#documentation)

---

## Architecture

Three processes run from one image, sharing the same Nest module graph.

```mermaid
flowchart LR
    Client["API client<br/>/ dashboard"] --> API["api<br/>REST · Swagger · dashboard"]

    API --> PG[("PostgreSQL")]
    API --> REDIS[("Redis")]

    SCHED["scheduler<br/>claim · sweep · digests"] --> PG
    SCHED -->|"fetch-feed queue"| REDIS

    REDIS -->|"fetch-feed<br/>alert-delivery"| WORKER["worker<br/>fetch · match · deliver"]
    WORKER --> PG
    WORKER --> ORIGINS[["RSS / Atom origins"]]

    WORKER --> WH["Webhook notifier"]
    WORKER --> EM["Email — Resend"]
    WORKER --> TG["Telegram Bot API"]

    API -.->|"scrapes /metrics"| WORKER
```

| Process     | Responsibility                                                                                |
| ----------- | --------------------------------------------------------------------------------------------- |
| `api`       | REST API, Swagger UI, static operator dashboard, health, readiness and merged metrics.        |
| `scheduler` | Timer loop: releases stranded claims, claims due feeds, enqueues fetch jobs, flushes digests. |
| `worker`    | Consumes four BullMQ queues; fetches, parses, matches, persists and delivers.                 |

The layout is hexagonal where a seam buys something — `FeedFetcherPort` and
`AlertNotifierPort` have real alternate implementations and test doubles — and plain
otherwise. Repositories talk raw SQL directly, because PostgreSQL is not being swapped and
the schema leans on features an ORM would make you escape-hatch around anyway.

Full detail, including the ingestion sequence and the ten modules:
**[docs/architecture.md](./docs/architecture.md)**.

---

## Quickstart

Requires Docker with `docker compose`, and Node.js 24 (the version in `.nvmrc`, and the
floor `package.json` declares in `engines`) if you want to run the processes on the host.

### Option A — the whole stack in Docker

```bash
git clone https://github.com/FullFran/feedpulse.git
cd feedpulse
cp .env.example .env
docker compose up -d --build
```

The `api` service runs `node dist/scripts/migrate.js` before starting, so migrations are
applied for you and `BOOTSTRAP_API_KEY` is seeded into the `api_keys` table. Give it a
moment on the first run — the readiness probe has a 90 second start period precisely because
a cold start applies every migration first.

```bash
curl http://127.0.0.1:3000/health
curl -H "x-api-key: fp_bootstr_change-me-before-you-expose-this" \
     http://127.0.0.1:3000/api/v1/feeds
```

Change `BOOTSTRAP_API_KEY` in `.env` before exposing anything.

### Option B — dependencies in Docker, processes on the host

Useful while developing, because you get a fast edit/restart loop.

```bash
git clone https://github.com/FullFran/feedpulse.git
cd feedpulse
npm ci
cp .env.example .env

docker compose up -d postgres redis
```

`.env.example` points `DATABASE_URL` at the Compose-internal hostname `postgres`, which the
host cannot resolve. Override the two URLs with the published host ports — `55432` and
`56379` by default — before running anything on the host:

```bash
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/rss_monitor
export REDIS_URL=redis://127.0.0.1:56379
export NODE_ENV=development

npm run migrate         # applies db/migrations and seeds BOOTSTRAP_API_KEY
npm run start:api       # terminal 1
npm run start:scheduler # terminal 2
npm run start:worker    # terminal 3
```

Then register a feed and a rule:

```bash
KEY=fp_bootstr_change-me-before-you-expose-this

curl -X POST http://127.0.0.1:3000/api/v1/feeds \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/rss.xml","poll_interval_seconds":1800}'

curl -X POST http://127.0.0.1:3000/api/v1/rules \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Grid outages","include_keywords":["power outage","São Paulo"],"exclude_keywords":["scheduled maintenance"]}'
```

### Where to look

| URL           | What it is                                                    |
| ------------- | ------------------------------------------------------------- |
| `/health`     | Liveness. Answers from process state alone.                   |
| `/ready`      | PostgreSQL, Redis and schema readiness. `503` when any fails. |
| `/metrics`    | Prometheus text format, API and worker registries merged.     |
| `/docs`       | Swagger UI. Gated on `ENABLE_SWAGGER`.                        |
| `/docs-json`  | The OpenAPI document. Same flag.                              |
| `/dashboard/` | Static operator dashboard.                                    |

`ENABLE_SWAGGER` defaults to on outside production — but `.env.example` ships
`NODE_ENV=production` and `ENABLE_SWAGGER=false`, so **Option A answers `404` on `/docs` and
`/docs-json`** until you set `ENABLE_SWAGGER=true` in `.env`. Option B, which exports
`NODE_ENV=development`, serves both. The same document is committed at
[`docs/openapi.json`](./docs/openapi.json) either way.

### Dashboard

A static operator dashboard is served from the API origin at `/dashboard/`. It reads the
same REST API as any other client — there is no privileged back channel.

![FeedPulse dashboard overview: feed counts, ingestion volume and recent activity](./docs/assets/dashboard-overview.png)

![FeedPulse dashboard alerts view: generated alerts with their matched rules and delivery state](./docs/assets/dashboard-alerts.png)

---

## Configuration

Every variable is parsed and validated at startup by `src/shared/config/env.schema.ts`. A
malformed value fails the boot rather than silently degrading. A key the schema does not
declare is stripped, not rejected — so a misspelled variable name is silently inert rather
than fatal. `.env.example` is the annotated template; the table below covers what most
deployments need.

### Required

| Variable       | Notes                                                                              |
| -------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL` | PostgreSQL connection string. There is no `POSTGRES_HOST` — this is the only knob. |
| `REDIS_URL`    | Redis connection string.                                                           |

### Core runtime

| Variable              | Default         | Notes                                                  |
| --------------------- | --------------- | ------------------------------------------------------ |
| `NODE_ENV`            | `development`   | `development` \| `test` \| `production`.               |
| `PORT`                | `3000`          | API HTTP port.                                         |
| `LOG_LEVEL`           | `info`          | `fatal` … `trace`.                                     |
| `SHUTDOWN_TIMEOUT_MS` | `30000`         | Force-exit deadline armed on the first SIGINT/SIGTERM. |
| `ENABLE_SWAGGER`      | on outside prod | Serves `/docs` and `/docs-json`.                       |
| `CORS_ORIGINS`        | unset           | Comma-separated allow-list. Empty disables CORS.       |

### Authentication

| Variable                                     | Default         | Notes                                                                 |
| -------------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `ENABLE_AUTH`                                | `false`         | Startup **fails** if this is false while `NODE_ENV=production`.       |
| `AUTH_PROVIDER`                              | `clerk_api_key` | `api_key` \| `clerk` \| `clerk_api_key`. Anything else fails startup. |
| `BOOTSTRAP_API_KEY`                          | unset           | Seeded into `api_keys` by `npm run migrate`, idempotently.            |
| `BOOTSTRAP_API_KEY_TENANT_ID`                | `legacy`        |                                                                       |
| `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` | unset           | Only for the Clerk providers.                                         |

### Scheduling and fetching

| Variable                                 | Default | Notes                                                           |
| ---------------------------------------- | ------- | --------------------------------------------------------------- |
| `SCHEDULER_TICK_MS`                      | `15000` |                                                                 |
| `SCHEDULER_BATCH_SIZE`                   | `100`   | Feeds claimed per tick. **Clamped to 40** — see the note below. |
| `SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS` | `300`   | Must stay above `RATE_LIMIT_MAX_BACKOFF_MS + FETCH_TIMEOUT_MS`. |
| `WORKER_CONCURRENCY`                     | `5`     | **Clamped to 3** — see the note below.                          |
| `FETCH_TIMEOUT_MS`                       | `10000` |                                                                 |
| `RATE_LIMIT_REQUESTS_PER_SECOND`         | `2`     | **Outbound**, per feed domain.                                  |
| `RATE_LIMIT_BASE_BACKOFF_MS`             | `1000`  | Outbound backoff base.                                          |
| `RATE_LIMIT_MAX_BACKOFF_MS`              | `60000` | Outbound backoff ceiling.                                       |

> **The two clamps are real and they sit above the defaults.** `AppConfigService`
> caps `SCHEDULER_BATCH_SIZE` at `40` and `WORKER_CONCURRENCY` at `3`
> (`src/shared/config/app-config.service.ts`), so the `100` and `5` in the table
> are the schema defaults, not the effective values — raising either variable past
> its cap has no effect and emits no warning. The caps were added deliberately to
> bound scheduler load. To get more throughput, run more `worker` replicas rather
> than raising `WORKER_CONCURRENCY`.

### Inbound limits and safety

| Variable                        | Default    | Notes                                                             |
| ------------------------------- | ---------- | ----------------------------------------------------------------- |
| `RATE_LIMIT_TTL_SECONDS`        | `60`       | Window for the inbound per-tenant buckets.                        |
| `RATE_LIMIT_MAX_REQUESTS`       | `300`      | Every `/api/` route. `0` disables.                                |
| `RATE_LIMIT_WRITE_MAX_REQUESTS` | `30`       | Enqueue/outbound endpoints. `0` disables.                         |
| `MAX_FEEDS_PER_TENANT`          | `500`      | `0` disables the cap.                                             |
| `ALLOW_PRIVATE_FEED_HOSTS`      | `false`    | Disables the SSRF host checks. Self-hosted and smoke stacks only. |
| `FEED_FETCH_MAX_BYTES`          | `5242880`  | Streamed body cap, 5 MiB.                                         |
| `OPML_UPLOAD_MAX_BYTES`         | `10485760` | 10 MiB, enforced at the stream level.                             |

### Notifications and observability

| Variable                               | Default                    | Notes                                                                                                    |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `WEBHOOK_NOTIFIER_URL`                 | unset                      | Unset selects the no-op notifier.                                                                        |
| `WEBHOOK_NOTIFIER_TIMEOUT_MS`          | `5000`                     |                                                                                                          |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | unset                      | Email channel.                                                                                           |
| `RESEND_DAILY_LIMIT`                   | `100`                      | Per tenant, UTC day. `0` disables the quota.                                                             |
| `TELEGRAM_BOT_TOKEN`                   | unset                      | Global fallback bot.                                                                                     |
| `TELEGRAM_API_URL`                     | `https://api.telegram.org` |                                                                                                          |
| `TENANT_SECRETS_MASTER_KEY`            | unset                      | Enables per-tenant bot tokens. Must decode to ≥32 bytes of base64; well-known placeholders are rejected. |
| `WORKER_METRICS_PORT`                  | `3001`                     | Scraped by the API's `/metrics`.                                                                         |
| `WORKER_METRICS_BIND`                  | `0.0.0.0`                  | Use `127.0.0.1` outside a private network.                                                               |
| `METRICS_AUTH_TOKEN`                   | unset                      | Unset leaves `/metrics` **open**.                                                                        |

---

## Authentication

Authentication is real: credentials live in the `api_keys` table, only `sha256(key)` is
stored, lookup goes through a partial index on `revoked_at IS NULL`, and the comparison is
`timingSafeEqual`. Unknown, malformed and revoked keys are deliberately indistinguishable to
the caller.

Mint a key:

```bash
npm run apikey:create -- --tenant my-tenant --label laptop
```

```
API key created. Store it now — it cannot be recovered.
  id:        2
  tenant:    acme
  label:     laptop
  prefix:    92cb32ac
  key:       fp_92cb32ac_YFdzGCjd4CFCmfjupSPWMfB18P8Y4xmwZc0Fs2DCn7Q
```

The plaintext key is printed exactly once. The `prefix` is stored in clear so a key stays
identifiable in the UI and in logs without the secret ever appearing there.

Send it on every `/api/` request:

```
x-api-key: fp_<prefix>_<secret>
```

`Authorization: Bearer <key>` also works, and with `AUTH_PROVIDER=clerk` or `clerk_api_key` a
three-segment Clerk JWT in the same header is verified as a session token instead. The tenant
is resolved once per request by a global guard; every repository query filters on it.

`GET /api/v1/auth/dashboard-config` is the single public `/api/` route — the dashboard has to
reach it before it owns a credential.

`ENABLE_AUTH=false` resolves every request to the shared `legacy` tenant with no credential.
It is a local development mode, and the environment schema refuses to boot a
`NODE_ENV=production` process in it.

---

## Rules

A rule is two keyword lists. There is no `field`, `operator` or `value`.

```json
{
  "name": "Grid outages",
  "include_keywords": ["power outage", "São Paulo"],
  "exclude_keywords": ["scheduled maintenance"],
  "is_active": true
}
```

Matching runs over the entry's **title and content combined**, and behaves as follows:

- **Accent- and case-insensitive.** Both sides are normalized to Unicode NFD, combining
  diacritics are stripped, text is lowercased and whitespace runs collapse. The keyword
  `São Paulo` matches a headline that writes `Sao Paulo`, and vice versa, and a phrase still
  matches a headline that wraps across lines.
- **Whole word or whole phrase.** Boundaries use Unicode lookarounds, not `\b`, so the
  keyword `ai` does **not** match `said` or `certain`, and `outage` does not match
  `outages`. Keywords like `c++` and non-Latin scripts work correctly for the same reason.
  There is no substring fallback — substring matching is the bug this module exists to
  remove.
- **Include is OR, exclude is a veto.** Any include keyword matching is enough; any exclude
  keyword matching suppresses the rule. A rule whose include list is empty after trimming
  never matches, so an empty array cannot become a match-all firehose.
- **Bounded and tenant-scoped.** 20 keywords per list, 200 characters each, names unique per
  tenant.

`POST /api/v1/rules/batch` creates up to 50 rules in one call. It is create-only: a name the
tenant already has is reported back untouched, never overwritten, and the response accounts
for every submitted name exactly once as `created`, `skippedNames` or `duplicateNames`.

---

## API

Domain routes live under `/api/v1`; operational routes sit outside it so orchestrators do
not track the API version. Lists use `page` / `page_size` (default `1` / `50`, max `200`)
and return a `has_next` flag. Successes are `{ data, meta }`; failures are one flat
envelope with a stable `snake_case` `code`.

| Group      | Routes                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feeds      | `POST /feeds` · `POST /feeds/validate` · `GET /feeds` · `GET /feeds/:id` · `PATCH /feeds/:id` · `POST /feeds/:id/check-now` · `DELETE /feeds/:id` |
| Rules      | `POST /rules` · `POST /rules/batch` · `GET /rules` · `GET /rules/:id` · `PATCH /rules/:id` · `DELETE /rules/:id`                                  |
| Entries    | `GET /entries` — filters: `feed_id`, `search`, `from`, `to`                                                                                       |
| Alerts     | `GET /alerts` · `GET /alerts/:id` · `POST /alerts/:id/send`                                                                                       |
| Settings   | `GET /settings` · `PUT /settings`                                                                                                                 |
| OPML       | `POST /opml/imports` · `GET /opml/imports/:id/preview` · `POST /opml/imports/:id/confirm` · `GET /opml/imports/:id/status`                        |
| Dashboard  | `GET /auth/dashboard-config` (public)                                                                                                             |
| Operations | `GET /ops/summary` · `GET /health` · `GET /ready` · `GET /metrics`                                                                                |

`DELETE` on a feed or a rule **disables** it — persisted history keeps referencing it.
`/entries` is feed-filtered by query parameter, not by a nested path.

The full contract, with request and response bodies, filters, error codes and limits:
**[docs/api.md](./docs/api.md)**. The machine-readable document is committed at
[`docs/openapi.json`](./docs/openapi.json) and regenerated with `npm run docs:openapi`, so a
pull request that changes a route shows the contract change in its own diff.

---

## Performance

![Feed capacity benchmark: total ingestion time across 100, 1,000, 5,000 and 10,000 feeds, growing as O(n^0.55)](./docs/benchmark-scaling-chart.svg)

Four stages — **100, 1,000, 5,000 and 10,000 feeds** — driven through the real API, with
per-stage artifacts written under `artifacts/benchmark/`. Total wall time grows as roughly
**O(n^0.55)**, i.e. sublinearly: per-feed cost falls as the batch grows, because the fixed
per-tick and per-connection costs amortise.

Per-feed cost across the four stages: **21.66 → 53.53 → 2.24 → 5.75 ms/feed**.

Read those numbers honestly:

- The feeds are served by the **local deterministic fixture** in `scripts/smoke`, not by the
  live internet. This measures the ingestion pipeline — queue, fetch, parse, dedupe, match,
  persist — with network variance removed on purpose. It is not a claim about how fast
  10,000 real sites respond.
- The chart is a **single local run** on unspecified hardware. Absolute milliseconds are
  machine-dependent and are not portable; the exponent and the shape are what the run is
  evidence for.
- Reproduce it yourself with `npm run benchmark:stages:mvp` and compare against your own
  hardware. See [docs/local-benchmark.md](./docs/local-benchmark.md).

---

## Engineering notes

Four places where the obvious implementation is wrong, and the repository says why.

**The alert upsert distinguishes insert from update with `xmax`.**
`AlertsRepository.createForEntryWithRules` writes a whole batch of alerts in one
`INSERT … ON CONFLICT … DO UPDATE … RETURNING (xmax = 0) AS inserted`. `xmax = 0` is true
only for tuples that statement actually inserted, which is what separates "new alert,
deliver it" from "existing alert that merely gained another matching rule, do not
re-deliver". A read-then-write would be racy; a plain `DO NOTHING` would lose the new rule.
→ [ADR 0003](./docs/adr/0003-canonical-link-alert-dedupe.md)

**The canonicalizer has a SQL/TypeScript parity spec, and it cost a design tradeoff.**
The alert dedupe key is a canonicalized article URL, produced in TypeScript at ingestion
and in plpgsql by migration 0018's backfill. If the two disagree by one byte, a backfilled
row and a fresh row for the same article stop colliding and the tenant gets exactly the
duplicate the migration exists to prevent. The TypeScript side used to normalize the query
through `URLSearchParams`, whose WHATWG form serializer rewrites `%20`→`+` and `%41`→`A` —
unreproducible in plpgsql without reimplementing a percent-encode set that includes every
code point above U+007E. The query is now read from the original input string and left
byte-stable instead. `test/canonical-link-parity.integration-spec.ts` proves the two agree.

**SSRF containment re-validates every redirect hop.**
Validating a URL once and letting `fetch` follow redirects is a bypass: a public origin can
answer `302 Location: http://169.254.169.254/` and land you on cloud metadata. `safeFetch`
uses `redirect: 'manual'`, resolves each `Location` against the current hop and re-runs the
host check before issuing the next request, with at most 5 hops and a streamed body cap.
What it deliberately does _not_ do is DNS-rebinding protection — `url-safety.ts` explains
why a half-implementation would buy only a false sense of safety.

**The scheduler claims feeds, and sweeps before it claims.**
Selection and reservation are one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`,
so two schedulers cannot dispatch the same feed. Because that statement also pushes
`next_check_at` forward, a worker dying mid-fetch would strand the feed for a whole poll
interval — so `ReleaseStuckFeedsUseCase` runs _first_ in every tick and recovery happens
within one tick instead. New check times carry `min(300s, 20% of the interval)` of jitter,
because feeds registered together otherwise stay in lockstep forever.
→ [ADR 0002](./docs/adr/0002-bullmq-over-cron.md)

---

## Testing

```bash
npm test                  # everything, serially
npm run test:unit         # pure unit specs, parallel workers
npm run test:integration  # Nest bootstrap / pg-mem / real PostgreSQL
npm run smoke:ci          # full Docker stack, end to end, self-cleaning
```

The naming convention is the only switch: `*.spec.ts` is a pure unit test with no I/O;
`*.integration-spec.ts` may use pg-mem, a Nest `TestingModule` or a real database.

### Database-gated suites

Several suites assert against a real PostgreSQL and **skip silently** when
`TEST_DATABASE_URL` is unset. A green `npm test` without a database is therefore a weaker
signal than it looks: it leaves the migration runner, schema parity, tenant isolation, the
feed claim/sweep and the canonical-link dedupe unexercised.

```bash
docker run -d --rm --name fp-test --network host \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=feedpulse_test -e PGPORT=55999 \
  postgres:16-alpine

TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55999/feedpulse_test npm test

docker rm -f fp-test
```

That schema is **wiped** on every run, and the role needs `CREATE DATABASE` — the
migration-fidelity suite provisions a throwaway database per run. CI provisions
`postgres:16-alpine` and exports `TEST_DATABASE_URL`, so these suites do run on every pull
request.

[docs/testing.md](./docs/testing.md) documents the shared harness and, more usefully, the
measured `pg-mem` capability boundary — what the emulator supports, what is shimmed, and
which migrations therefore require a real PostgreSQL.

---

## Quality gates

Every gate below runs on each pull request, and each is reproducible locally with the same
command CI uses. The first five are the `.github/workflows/ci.yml` job, in order; the audit
is a separate job in `codeql.yml`, which also runs on every pull request to `main`.

```bash
npm run lint          # ESLint (flat config, type-aware) — must report 0 errors
npm run format:check  # Prettier — no diff allowed
npm run typecheck     # tsc --noEmit, incremental disabled
npm run test:cov      # Jest with coverage thresholds enforced
npm run build         # Emits dist/ — the artifact the image runs
npm audit --audit-level=high --omit=dev   # Blocking supply-chain gate (codeql.yml)
```

Two gates are easy to get subtly wrong:

- `typecheck` passes `--incremental false` on purpose. With the build info cache warm,
  `tsc --noEmit` can report zero errors on a tree that does not actually compile.
- The `overrides` block in `package.json` is what holds `npm audit` at zero
  vulnerabilities. Removing it turns the audit gate red.

Coverage thresholds are a ratchet set just under the **database-less** run, since that is the
weakest run anyone can perform. Raise them as coverage rises; never lower them to make a
build pass. `.github/workflows/smoke.yml` reuses this workflow and gates a full Docker stack
run behind it; `codeql.yml` adds static analysis and a dependency-advisory gate; `nightly.yml`
runs the suite on the next Node major and the capacity benchmark.

---

## Roadmap and known limits

Stated plainly, because a portfolio README that lists only strengths is not evidence of
judgement.

**Not implemented**

- **DNS-rebinding protection.** `url-safety.ts` validates the hostname literal. A host that
  resolves public at validation time and private at connect time is not blocked. Closing it
  needs a custom undici dispatcher pinned to the validated IP.
- **`fetch_logs` retention.** The table grows without bound and has no pruning job. It needs
  one before a long-lived deployment.
- **Per-attempt delivery history.** Delivery state is three status columns on the alert row,
  not an `alert_deliveries` child table. The upgrade path is documented in
  [ADR 0004](./docs/adr/0004-per-channel-delivery-tracking.md).
- **Field-level validation detail.** The error envelope carries a stable `code` but no
  `details` map, so a validation failure says `rule_keyword_too_long`, not which keyword.
  [ADR 0005](./docs/adr/0005-single-error-envelope.md) records why a second envelope was
  rejected and what the additive fix looks like.
- **Full-text search.** `GET /entries?search=` is an `ILIKE '%…%'` scan; the GIN index on
  `to_tsvector(normalized_search_document)` exists but no query path uses it yet, which is
  why the search term is capped at 200 characters.
- **Adaptive polling.** `poll_interval_seconds` is whatever you set. The original design
  called for intervals that tighten on active feeds and widen on quiet ones. Only half the
  input exists: ingestion writes `feeds.avg_response_ms` on every fetch, but
  `feeds.avg_items_per_day` is declared by migration 0001 and never written, so it is always
  `NULL`. Both the backfill and the policy remain to be written.
- **Down migrations.** Migrations are append-only and checksummed. Rolling back means
  writing a new forward migration.

**Deliberate constraints**

- One scheduler. The claim is safe under concurrency, but more schedulers add contention,
  not throughput. Scale the worker.
- Redis is required. Losing it costs the jobs in flight, which the claim sweep recovers on
  the next tick — but the ingestion path is down while it is down.
- The alert dedupe key is a URL, so a publisher that changes an article's URL produces a
  second alert.

---

## Documentation

| Document                                                   | Contents                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| [docs/architecture.md](./docs/architecture.md)             | Runtimes, modules, ports and adapters, ingestion flow, scaling. |
| [docs/api.md](./docs/api.md)                               | The living HTTP contract.                                       |
| [docs/database.md](./docs/database.md)                     | The schema as the migrations actually build it.                 |
| [docs/testing.md](./docs/testing.md)                       | Suite layout, harness, and the pg-mem capability boundary.      |
| [docs/adr/](./docs/adr/)                                   | Decision records.                                               |
| [docs/local-smoke.md](./docs/local-smoke.md)               | Deterministic full-stack smoke flow.                            |
| [docs/local-benchmark.md](./docs/local-benchmark.md)       | Feed-capacity benchmark.                                        |
| [docs/deployment-dokploy.md](./docs/deployment-dokploy.md) | Single-VPS deployment.                                          |

## Tech stack

Node.js 24 · TypeScript 5 · NestJS 11 · PostgreSQL (raw SQL via `pg`) · Redis + BullMQ ·
`rss-parser` · Zod and `class-validator` · `prom-client` · `nestjs-pino` · Jest, `pg-mem`
and supertest.

## Project

| Document                                   | Contents                                                    |
| ------------------------------------------ | ----------------------------------------------------------- |
| [CONTRIBUTING.md](./CONTRIBUTING.md)       | Local setup, the gates CI runs, commit and migration rules. |
| [CHANGELOG.md](./CHANGELOG.md)             | What changed, in Keep a Changelog format.                   |
| [SECURITY.md](./SECURITY.md)               | How to report a vulnerability, and the known gaps.          |
| [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Contributor Covenant 2.1.                                   |

## License

MIT. See [LICENSE](./LICENSE).
