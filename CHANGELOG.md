# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No release has been tagged yet, so there are no comparison links below. Versions
here map to the `version` field in `package.json`.

## [Unreleased]

Hardening pass across authentication, outbound HTTP, rule matching, alert
deduplication, job durability and the development toolchain. Several entries
below describe behaviour that was actively wrong before, not merely missing.

### Added

- **API key management.** `db/migrations/0014_api_keys.sql` introduces an `api_keys` table storing a clear-text `prefix` for identification and only `sha256(key)` for verification, plus `label`, `last_used_at` and `revoked_at`. Keys are minted with `npm run apikey:create -- --tenant <tenant-id> [--label <label>]` and printed exactly once.
- **Feed URL validation endpoint.** `POST /api/v1/feeds/validate` checks a candidate feed URL before it is registered.
- **Batch rule creation.** `POST /api/v1/rules/batch` creates several rules in one request, backed by `ON CONFLICT (tenant_id, name)`.
- **Dead-letter store.** `db/migrations/0019_dead_letter_jobs.sql` and `src/infrastructure/queue/dead-letter.repository.ts` persist jobs that exhausted their retries, so a permanently failing job is inspectable instead of only being a log line. Queue labels are drawn from a closed set of four queue names to keep Prometheus cardinality bounded.
- **Inbound rate limiting.** `src/shared/http/throttler.module.ts` adds a Redis-backed limiter over `/api/` routes, reusing the BullMQ Redis connection so limits are global rather than per replica. It degrades to an in-process fallback (with a warning) when the injected connection cannot run Lua.
- **Structured logging and error envelopes.** `nestjs-pino` with credential redaction, a `RequestIdInterceptor`, and an `AllExceptionsFilter` producing a single error response shape.
- **Stuck-feed recovery.** `db/migrations/0015_feed_claim_sweep.sql` adds `feeds.claimed_at`, set atomically when a feed is claimed and cleared on both the success and the failure path. A sweep resets claims older than `SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS`, so a worker crash between claim and fetch no longer strands a feed for a whole poll interval.
- **Test harness.** Shared builders, fakes, HTTP helpers and schema utilities under `test/support/`, and a Jest split into separate unit and integration projects (`npm run test:unit`, `npm run test:integration`).
- **CI and supply chain.** A `CI` workflow running lint, format check, typecheck, coverage and build against a real PostgreSQL service container, reusable by the smoke workflow; plus nightly, CodeQL and Dependabot configuration.
- **Toolchain configuration.** ESLint flat config, Prettier, `.editorconfig`, `.nvmrc`, `.dockerignore` and `.git-blame-ignore-revs`.
- **Living documentation.** `docs/` gains an index, `architecture.md`, `api.md`, `database.md` (regenerated from a real migrated schema), `testing.md`, `deployment-dokploy.md` and five ADRs. `docs/openapi.json` is committed and regenerated with `npm run docs:openapi`, which reads `/docs-json` back off a booted app so it cannot drift from the controllers.
- **Developer entry points.** A self-documenting `Makefile` (`make help`), an idempotent demo seeder (`npm run demo:seed`) that goes through the public HTTP API, and a dependency-free dashboard screenshot capture (`npm run docs:screenshots`) driving Chrome over the DevTools Protocol.
- **Community health files.** `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog, issue forms and a pull request template.

### Changed

- **Everything ships in English.** The README, `docs/`, the operator dashboard and the remaining code comments were mixed Spanish and English; the Spanish planning documents that contradicted the built system were replaced by documentation derived from the source and exercised against a running stack. The Swagger `example` values on `CreateRuleDto` and `UpdateRuleDto` — which are published in `docs/openapi.json` and at `/docs` — are English too. The only Spanish left is test fixture data that exists to prove accent-insensitive matching. The original product brief is kept, translated, at `docs/archive/PRD-es.md`.
- **Package metadata reflects the project.** `package.json` is renamed `rss-monitor` -> `feedpulse` and gains `license`, `author`, `repository`, `bugs`, `homepage` and `keywords`. `engines.node` moves from `>=22.0.0` to `>=24.0.0`, the version `.nvmrc`, CI and the Dockerfile already pin. The PostgreSQL database and the smoke/benchmark Compose project names deliberately stay `rss_monitor` / `rss-monitor-*` so existing volumes survive.
- **The API document is titled FeedPulse.** `DocumentBuilder` in `src/main/create-api-app.ts` no longer advertises "RSS Monitor API" or an MVP.
- **`noUncheckedIndexedAccess` is on.** Indexed reads of SQL result rows and regex capture groups are typed as possibly-undefined across `src/`, `test/` and `scripts/`. Every call site was fixed with a real guard; tests use a `expectDefined()` helper rather than `!`, which `@typescript-eslint/no-unnecessary-type-assertion` would reject.
- **The operator dashboard is accessible.** Real tablist semantics with arrow-key navigation, visible focus rings, live-region feedback, per-table empty states and dark/light theming.

- **Migrations are enforced append-only.** The runner records a SHA-256 checksum per applied migration and refuses to continue when a file that already ran has been edited, naming the next free version to use instead.
- **Search-text normalization is unified.** `db/migrations/0016_unify_search_normalization.sql` makes `normalized_search_document` a stored generated column and adds `feedpulse_normalize_search_text()`, mirrored exactly by `src/shared/text/normalize-search-text.ts`. Four divergent normalizers had made it possible for a keyword to match in memory and miss in SQL.
- **Container hardening.** The image runs as the unprivileged `node` user (uid 1000).

### Fixed

- **Include keywords are OR, not AND.** Rule matching used `Array.prototype.every` over `include_keywords`, so a rule with several keywords only fired when an entry contained all of them, and a rule with an empty include list matched every entry. `src/modules/ingestion/domain/keyword-match.ts` now requires any one include keyword to match, lets any exclude keyword veto, and never matches on an empty include list.
- **Keyword boundaries are Unicode-aware.** Matching used ASCII `\b`, which failed on `c++`, Cyrillic and Greek keywords. Boundaries are now Unicode lookarounds, so the keyword `ai` no longer matches `said` and non-Latin keywords work.
- **Alert creation is atomic.** Alerts are inserted with an UPSERT that reports `(xmax = 0) AS inserted`, replacing a read-then-write that could duplicate under concurrency.
- **Alert deduplication covers links that cannot be canonicalized.** `db/migrations/0018_alerts_canonical_relink_and_index_cleanup.sql` recomputes `canonical_link` with the current canonicalizer (the old one kept `utm_*` tracking parameters, so one article syndicated with different tags produced several alerts), and replaces two partial unique indexes with one total index keyed on `COALESCE(canonical_link, 'entry:' || entry_id)`. Alerts with a NULL canonical link were previously unconstrained. Pending Telegram digest items are repointed at the surviving alert before duplicates are deleted.
- **Entry identity survives headline edits.** `db/migrations/0017_entries_content_hash_backfill.sql` recomputes `content_hash` from `link | guid | published_at` instead of `title | link | published_at`. A revised headline used to be ingested as a new entry and produce a second alert; the backfill prevents a burst of duplicates on the first poll after upgrade.
- **Rule names are unique per tenant.** `db/migrations/0020_rules_unique_tenant_name.sql` adds the uniqueness rule `upsertByName` always assumed, closing a race in which two concurrent OPML imports both inserted the same rule.
- **The migration-fidelity suite no longer flakes on teardown.** `test/migrations.integration-spec.ts` drops its throwaway database with `WITH (FORCE)`, which terminates any backend its pool has not finished closing. `pg` surfaced that as an idle-client `error` event with no listener, so Node reported an unhandled error and Jest failed the suite _after_ all nine tests had passed — intermittently, roughly one full run in three. The pool now ignores the expected `57P01` shutdown code and still treats every other code as fatal.

### Security

- **API keys are verified instead of trusted.** Any non-empty `X-API-Key` header or non-JWT bearer token was previously accepted and mapped straight to a tenant identifier — a request only had to supply a string to become that tenant. Keys are now looked up by hash, must satisfy `revoked_at IS NULL`, and are compared with `timingSafeEqual`.
- **Authentication can no longer be disabled by accident.** The single bypass is the explicit `ENABLE_AUTH` setting, never `NODE_ENV`, and an unrecognized `AUTH_PROVIDER` now fails at startup rather than silently rejecting every request at runtime.
- **SSRF containment on outbound fetches.** `src/shared/http/url-safety.ts` rejects loopback, link-local (including cloud metadata at `169.254.169.254`), private and unique-local targets, and `src/shared/http/safe-fetch.ts` follows redirects manually so every hop is revalidated. Response bodies are capped and the redirect chain is bounded. DNS rebinding is explicitly out of scope and documented as such.
- **Tenant secrets use a real KDF and are bound to their tenant.** Stored Telegram bot tokens move from an unsalted `sha256(TENANT_SECRETS_MASTER_KEY)` with no AAD to a scrypt-derived key with the owning `tenant_id` as AES-256-GCM additional authenticated data, so a ciphertext blob can no longer be moved between tenant rows. `db/migrations/0021_tenant_secrets_key_version.sql` records the derivation version per row, so existing ciphertext still decrypts and a botched key rotation fails loudly instead of silently falling back to the operator's global bot token.
- **HTTP surface hardening.** `helmet` with a content security policy, a CORS allowlist that denies all origins when unset, and request body size limits.
- **Log redaction.** Credentials and tokens are redacted from structured log output.

## [0.1.0] - 2026-04-12

Initial RSS monitoring platform.

### Added

- Three-runtime architecture: `api` (REST + Swagger + operator dashboard), `scheduler` (enqueues feed-fetch jobs when feeds become due) and `worker` (fetches feeds, evaluates rules, enqueues alert deliveries).
- Feed, entry, rule and alert CRUD over `/api/v1/`, with an on-demand feed check.
- OPML import under `/api/v1/opml/imports`: upload, preview, confirm and status endpoints, plus the parse and apply workers behind them.
- Multi-tenancy isolating feeds and rules per API key.
- Notification channels: webhooks, Resend email per tenant, and Telegram in both instant and digest modes, including tenant-specific bot tokens.
- Tenant settings, including webhook configuration and Clerk-based dashboard authentication.
- Accent-insensitive keyword filters.
- Operator dashboard with entry search.
- Deployment assets for Dokploy.

### Fixed

- Feeds that fail terminally are auto-paused; errored feeds retry with backoff; scheduler load is capped to safe limits.
- OPML feed upsert made conflict-safe.
- Telegram messages no longer fail on Markdown parse errors.
- Alerts are deduplicated by canonical article link, tracked per delivery channel, and limited to one alert per article.
- Alert rules match on normalized phrases.
