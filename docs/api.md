# HTTP API

The living contract of the FeedPulse HTTP API. Every route, parameter and status code below
was read out of the controllers in `src/modules/*/http/` and verified against a running
instance.

The machine-readable version is [`openapi.json`](./openapi.json), regenerated with
`npm run docs:openapi`. A running instance also serves Swagger UI at `/docs` and the same
document at `/docs-json` whenever `ENABLE_SWAGGER` is true (the default outside
production).

## Conventions

### Base path

Domain routes are versioned under `/api/v1`. Operational routes (`/health`, `/ready`,
`/metrics`) sit outside it on purpose, so orchestrators and scrapers do not have to track
the API version.

### Authentication

Every path under `/api/` requires a credential. The one exception is
`GET /api/v1/auth/dashboard-config`, which the dashboard must reach before it owns one.

```
x-api-key: fp_<prefix>_<secret>
```

`Authorization: Bearer <key>` is accepted as well, and — when `AUTH_PROVIDER` is `clerk` or
`clerk_api_key` — a three-segment Clerk JWT in the same header is verified as a session
token instead.

Mint a key with:

```bash
npm run apikey:create -- --tenant my-tenant --label laptop
```

The plaintext key is printed exactly once. Only `sha256(key)` is stored; unknown, malformed
and revoked keys are all rejected identically with `401 invalid_api_key`, and a missing
credential returns `401 auth_required`.

### Success envelope

```json
{
  "data": {},
  "meta": {
    "timestamp": "2026-07-30T14:12:30.096Z",
    "request_id": "6057e397-3fc1-4054-adbb-b1503c5f1c5a"
  }
}
```

`request_id` echoes an inbound `x-request-id` header when present, and is generated
otherwise. It is also set on the response header, and it appears in every log line for the
request.

### Pagination envelope

List endpoints take `page` (default `1`, minimum `1`) and `page_size` (default `50`,
minimum `1`, maximum `200`). This is offset pagination, not cursor pagination.

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "page_size": 50,
    "total": 1250,
    "has_next": true,
    "timestamp": "2026-07-30T14:12:30.123Z",
    "request_id": "226d4b2f-8b57-4f14-870f-e6363f83a94d"
  }
}
```

### Error envelope

One flat shape for every failing request, produced by `AllExceptionsFilter`. There is no
second envelope and no nested `error` object — see
[ADR 0005](./adr/0005-single-error-envelope.md).

```json
{
  "statusCode": 401,
  "code": "auth_required",
  "message": "auth_required",
  "timestamp": "2026-07-30T14:12:30.021Z",
  "path": "/api/v1/feeds",
  "requestId": "fb412cee-427b-40c6-a8dd-3209e4d77c44"
}
```

`code` is a stable lower `snake_case` string and is the field clients should branch on.
`message` is for humans. Internal class names and stack traces never reach the client.

### Rate limiting

Two Redis-backed per-tenant budgets, both counted over `RATE_LIMIT_TTL_SECONDS`
(default 60s):

| Budget    | Applies to                                                                                                                                                              | Default |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `default` | every `/api/` route                                                                                                                                                     | 300     |
| `write`   | `POST /api/v1/feeds/:id/check-now`, `POST /api/v1/feeds/validate`, `POST /api/v1/opml/imports`, `POST /api/v1/opml/imports/:id/confirm`, `POST /api/v1/alerts/:id/send` | 30      |

Exceeding one returns `429` with `code: rate_limit_exceeded`, a `Retry-After` header and
`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`. Setting a budget to `0`
disables that bucket. Health, readiness and metrics are never throttled.

## Routes

The complete surface, as mapped by Nest at boot:

| Method   | Path                               | Success | Notes                                                       |
| -------- | ---------------------------------- | ------- | ----------------------------------------------------------- |
| `POST`   | `/api/v1/feeds`                    | 201     | Register a feed.                                            |
| `POST`   | `/api/v1/feeds/validate`           | 200     | Probe a URL before registering it. `write` budget.          |
| `GET`    | `/api/v1/feeds`                    | 200     | Paginated list.                                             |
| `GET`    | `/api/v1/feeds/:id`                | 200     | Detail.                                                     |
| `PATCH`  | `/api/v1/feeds/:id`                | 200     | Update status and/or poll interval.                         |
| `POST`   | `/api/v1/feeds/:id/check-now`      | 202     | Enqueue an immediate fetch. `write` budget.                 |
| `DELETE` | `/api/v1/feeds/:id`                | 204     | Disable; history is preserved.                              |
| `POST`   | `/api/v1/rules`                    | 201     | Create one rule.                                            |
| `POST`   | `/api/v1/rules/batch`              | 201     | Create up to 50 rules. Create-only.                         |
| `GET`    | `/api/v1/rules`                    | 200     | Paginated list.                                             |
| `GET`    | `/api/v1/rules/:id`                | 200     | Detail.                                                     |
| `PATCH`  | `/api/v1/rules/:id`                | 200     | Update name, keywords, active state.                        |
| `DELETE` | `/api/v1/rules/:id`                | 204     | Disable; alert history keeps referencing it.                |
| `GET`    | `/api/v1/entries`                  | 200     | Paginated list. `feed_id` is a query parameter.             |
| `GET`    | `/api/v1/alerts`                   | 200     | Paginated list.                                             |
| `GET`    | `/api/v1/alerts/:id`               | 200     | Detail.                                                     |
| `POST`   | `/api/v1/alerts/:id/send`          | 202     | Queue a delivery attempt. `write` budget.                   |
| `GET`    | `/api/v1/settings`                 | 200     | Tenant integration settings.                                |
| `PUT`    | `/api/v1/settings`                 | 200     | Replace tenant integration settings.                        |
| `POST`   | `/api/v1/opml/imports`             | 201     | Upload an OPML file. `multipart/form-data`. `write` budget. |
| `GET`    | `/api/v1/opml/imports/:id/preview` | 200     | Paginated preview plus a `summary` block.                   |
| `POST`   | `/api/v1/opml/imports/:id/confirm` | 202     | Idempotent confirm; enqueues the apply job. `write` budget. |
| `GET`    | `/api/v1/opml/imports/:id/status`  | 200     | Progress and partial-failure counters.                      |
| `GET`    | `/api/v1/auth/dashboard-config`    | 200     | Public. Clerk publishable key and active auth provider.     |
| `GET`    | `/api/v1/ops/summary`              | 200     | Tenant-scoped operational counters.                         |
| `GET`    | `/health`                          | 200     | Liveness. No I/O.                                           |
| `GET`    | `/ready`                           | 200/503 | PostgreSQL, Redis and schema readiness.                     |
| `GET`    | `/metrics`                         | 200     | Prometheus text format; API and worker registries merged.   |

`/dashboard/` is not a Nest route: it is static content served from `public/dashboard`.

### Feeds

`POST /api/v1/feeds`

```json
{
  "url": "https://example.com/rss.xml",
  "poll_interval_seconds": 1800,
  "status": "active"
}
```

- `url` is required and must be an absolute `http(s)` URL. Private, loopback and link-local
  targets are refused unless `ALLOW_PRIVATE_FEED_HOSTS=true`.
- `poll_interval_seconds` is optional, between `300` and `10800`. Default `1800`.
- `status` is optional, one of `active`, `paused`, `error`. Default `active`.

Response `201`:

```json
{
  "data": {
    "id": 1,
    "tenantId": "legacy",
    "url": "https://example.com/rss.xml",
    "status": "active",
    "etag": null,
    "lastModified": null,
    "lastCheckedAt": null,
    "nextCheckAt": "2026-07-30T14:12:30.093Z",
    "pollIntervalSeconds": 1800,
    "errorCount": 0,
    "lastError": null,
    "avgResponseMs": null,
    "avgItemsPerDay": null,
    "createdAt": "2026-07-30T14:12:30.093Z",
    "updatedAt": "2026-07-30T14:12:30.093Z"
  },
  "meta": { "timestamp": "...", "request_id": "..." }
}
```

Resource bodies use `camelCase` keys; query parameters and request bodies use
`snake_case`. That asymmetry is historic, and it is documented here rather than quietly
"fixed" in a doc that the code would then contradict.

`GET /api/v1/feeds` filters: `status`, `q` (substring match on the URL), `page`,
`page_size`.

`POST /api/v1/feeds/validate` fetches an arbitrary `http(s)` URL once and reports what it
found, so an operator can see what would be matched before committing:

```json
{
  "reachable": false,
  "statusCode": 404,
  "latencyMs": 177,
  "feedTitle": null,
  "itemCount": null,
  "latestItemPublishedAt": null,
  "sampleItems": [],
  "error": "http_404"
}
```

Transport and parse problems are reported in `error` from a closed vocabulary
(`dns_failure`, `connection_refused`, `tls_error`, `timeout`, `unsafe_protocol`,
`unsafe_host`, `too_many_redirects`, `invalid_redirect`, `response_too_large`,
`parse_error`, `http_4xx` / `http_5xx`, `unknown`) with a `200` response. Upstream error
text and response bodies are never echoed back.

`POST /api/v1/feeds/:id/check-now` answers `202` with `queued` when a new job was accepted
and `already_queued` when a fetch for that feed is already in flight.

### Rules

The rule model is `include_keywords` / `exclude_keywords`. There is no `field`, `operator`
or `value`.

```json
{
  "name": "Grid outages",
  "include_keywords": ["power outage", "São Paulo"],
  "exclude_keywords": ["scheduled maintenance"],
  "is_active": true
}
```

Semantics, implemented in `src/modules/ingestion/domain/keyword-match.ts`:

- Title and content are concatenated and normalized: Unicode NFD, combining diacritics
  stripped, lowercased, runs of whitespace collapsed. Matching is therefore
  **accent-insensitive and case-insensitive** — the keyword `São Paulo` matches a headline
  that writes `Sao Paulo`, and vice versa — and a keyword still matches a headline that
  wraps across lines.
- Each keyword is matched as a **whole word or whole phrase**, using Unicode lookarounds
  rather than `\b`. The keyword `ai` does not match `said` or `certain`, and `outage` does
  not match `outages`. Keywords like `c++` and non-Latin scripts work correctly for the same
  reason.
- **Any** include keyword matching is enough (OR). **Any** exclude keyword matching vetoes
  the rule. A rule whose include list is empty after trimming never matches.
- Both arrays are capped at 20 items of at most 200 characters each. Items are trimmed and
  empty entries dropped before validation.
- `name` is trimmed, capped at 120 characters, and unique per tenant.

`POST /api/v1/rules/batch` takes up to 50 rules and is create-only: a name the tenant
already uses is reported back untouched, never overwritten. The response accounts for every
submitted name exactly once across three disjoint lists:

```json
{
  "data": {
    "created": [
      {
        "id": 2,
        "name": "Evictions",
        "includeKeywords": ["eviction"],
        "excludeKeywords": [],
        "isActive": true,
        "createdAt": "...",
        "updatedAt": "..."
      }
    ],
    "skippedNames": ["Grid outages"],
    "duplicateNames": ["Evictions"]
  },
  "meta": { "timestamp": "...", "request_id": "..." }
}
```

`skippedNames` already existed; `duplicateNames` were listed more than once in the same
request, and only the first occurrence was used. A name can appear in `created` and in
`duplicateNames` at once, as `Evictions` does above: it was submitted twice, and the first
occurrence was created.

### Entries

`GET /api/v1/entries` — read only; there is no `GET /api/v1/entries/:id`.

| Parameter   | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `feed_id`   | Restrict to one feed.                                                      |
| `search`    | Substring match over the normalized title+content document. Max 200 chars. |
| `from`      | ISO-8601. Keeps entries with `COALESCE(published_at, fetched_at) >= from`. |
| `to`        | ISO-8601. Keeps entries with `COALESCE(published_at, fetched_at) <= to`.   |
| `page`      | Default `1`.                                                               |
| `page_size` | Default `50`, max `200`.                                                   |

`search` is deliberately capped: it lands in an `ILIKE '%...%'` scan that cannot use the
GIN index.

### Alerts

`GET /api/v1/alerts` filters on `sent` (`true` / `false`) plus pagination.

`POST /api/v1/alerts/:id/send` queues a delivery attempt and answers `202`. It is safe to
call repeatedly: channels already marked `sent` are skipped, so a retry after a Telegram
outage does not resend the webhook.

### Settings

`GET /api/v1/settings`:

```json
{
  "data": {
    "webhookNotifierUrl": null,
    "recipientEmails": [],
    "telegramChatIds": [],
    "telegramDeliveryMode": "instant",
    "telegramBotTokenConfigured": false
  },
  "meta": { "timestamp": "...", "request_id": "..." }
}
```

`PUT /api/v1/settings` replaces the whole object; an omitted field is reset, not preserved.
Accepted fields: `webhook_notifier_url` (absolute URL or `null`), `recipient_emails`
(array or a comma/newline separated string; lower-cased and de-duplicated),
`telegram_chat_ids` (numeric strings, de-duplicated), `telegram_delivery_mode`
(`instant` | `digest_10m`), `telegram_bot_token`, and `telegram_bot_token_clear`.

The bot token is never returned. It is encrypted with AES-256-GCM under a key derived from
`TENANT_SECRETS_MASTER_KEY`; only the boolean `telegramBotTokenConfigured` is exposed.

### OPML import

Four steps, asynchronous throughout:

1. `POST /api/v1/opml/imports` with `multipart/form-data` and a `file` field. Capped at
   `OPML_UPLOAD_MAX_BYTES` at the stream level, so an oversized body is aborted while it is
   still arriving. Returns the created import record.
2. `GET /api/v1/opml/imports/:id/preview` — a paginated envelope with an extra `summary`
   key holding the import record and its counters (total, valid, duplicate, existing,
   invalid, imported).
3. `POST /api/v1/opml/imports/:id/confirm` — idempotent, answers `202`, enqueues the apply
   job.
4. `GET /api/v1/opml/imports/:id/status` — progress with partial-failure visibility.

### Operational endpoints

`GET /health` answers from process state alone:

```json
{ "status": "ok", "checks": { "api": "ok" }, "timestamp": "..." }
```

`GET /ready` checks PostgreSQL, Redis and schema state, and returns `503` with the same
shape and `"status": "error"` if any of them fails:

```json
{ "status": "ok", "checks": { "postgres": "ok", "redis": "ok", "schema": "ok" }, "timestamp": "..." }
```

`GET /api/v1/ops/summary` returns tenant-scoped counters for the dashboard:

```json
{
  "data": {
    "feedsTotal": 1,
    "feedsActive": 1,
    "feedsError": 0,
    "entries24h": 0,
    "entries7d": 0,
    "alertsPending": 0
  },
  "meta": { "timestamp": "..." }
}
```

`GET /metrics` returns Prometheus text format, merging the API registry with a live scrape
of the worker's own metrics server. It requires `Authorization: Bearer <METRICS_AUTH_TOKEN>`
when that variable is set, and is open when it is not.

Exposed series include `rss_feeds_active_total`, `rss_feeds_error_total`, `rss_fetch_total`,
`rss_fetch_errors_total`, `rss_fetch_duration_ms`, `rss_fetch_duration_seconds`,
`rss_entries_ingested_total`, `rss_alerts_generated_total`, `rss_alerts_sent_total`,
`rss_alerts_undelivered`, `rss_alert_delivery_channel_failures_total`,
`rss_rate_limit_backoff_total`, `rss_opml_job_duration_ms`, `rss_opml_job_errors_total`,
`feedpulse_worker_metrics_up` and `feedpulse_worker_metrics_scrape_failures_total`.

## Error codes

Codes raised by the application, grouped by the status they carry.

| Status | Code                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`, `unsafe_feed_url`, `unsafe_webhook_url`, `opml_file_required`, `opml_file_invalid_type`, `opml_file_too_large`, `scheduler_batch_size_invalid`, `scheduler_stuck_threshold_invalid`, `tenant_secrets_tenant_id_required`, `tenant_telegram_token_empty`                                                  |
| 400    | `validation_failed` — the fallback whenever a `ValidationPipe` failure cannot be promoted (see below), e.g. `?page_size=201` answers `validation_failed` with the message `page_size must not be greater than 200`                                                                                                      |
| 400    | A validation failure is promoted to its own code when it is the **only** failed constraint and its message is already `snake_case`: `feed_invalid_url`, `feed_invalid_poll_interval`, `rule_missing_include_keywords`, `rule_keyword_too_long`, `entry_search_too_long`, `batch_rules_empty`, `batch_rules_exceeds_max` |
| 401    | `auth_required`, `invalid_api_key`, `missing_tenant_context`, `metrics_unauthorized`, and the Clerk-specific `clerk_session_invalid`, `clerk_session_not_active`, `clerk_token_expired`, `invalid_clerk_token`, `clerk_secret_key_missing`                                                                              |
| 403    | `feed_limit_reached`                                                                                                                                                                                                                                                                                                    |
| 404    | `feed_not_found`, `rule_not_found`, `alert_not_found`, `opml_import_not_found`                                                                                                                                                                                                                                          |
| 409    | `feed_already_exists`, `opml_import_not_ready_for_confirm`                                                                                                                                                                                                                                                              |
| 413    | `payload_too_large`                                                                                                                                                                                                                                                                                                     |
| 429    | `rate_limit_exceeded`                                                                                                                                                                                                                                                                                                   |
| 500    | `internal_server_error`                                                                                                                                                                                                                                                                                                 |
| 503    | `service_unavailable`                                                                                                                                                                                                                                                                                                   |

## Request limits

| Limit                   | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| JSON / urlencoded body  | 256 KiB                                                    |
| OPML upload             | `OPML_UPLOAD_MAX_BYTES`, default 10 MiB                    |
| Feeds per tenant        | `MAX_FEEDS_PER_TENANT`, default 500 (`0` disables the cap) |
| Rules per batch request | 50                                                         |
| Keywords per rule       | 20 include, 20 exclude, 200 characters each                |
| Page size               | 200                                                        |
