# ADR 0002 — A claim loop and BullMQ instead of cron

**Status:** accepted · **Applies to:** `src/modules/ingestion/scheduler.runner.ts`, `src/modules/feeds/feeds.repository.ts`, `src/infrastructure/queue/`

## Context

Up to 10,000 feeds each have their own polling interval, and the work has to keep flowing
while individual feeds are slow, unreachable or actively hostile. Three properties are
required:

- Two schedulers must never dispatch the same feed twice.
- A worker that dies mid-fetch must not strand its feed until the next interval.
- Fetch work must be able to scale independently of the process that decides _what_ to
  fetch.

A cron entry gives none of them. It fires on wall-clock time, has no notion of per-row
due-ness, no concurrency control across replicas, no retry, and no visibility.

## Decision

Two pieces, deliberately separate.

**Scheduling is a claim, in SQL.** `FeedsRepository.claimDueFeeds` is one statement:

```sql
UPDATE feeds
SET next_check_at = NOW() + (poll_interval_seconds + jitter) * interval '1 second',
    claimed_at = NOW(),
    updated_at = NOW()
WHERE id IN (
  SELECT id FROM feeds
  WHERE next_check_at <= NOW() AND claimed_at IS NULL AND …
  ORDER BY … LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING *
```

Selection and reservation happen atomically. `FOR UPDATE SKIP LOCKED` means a second
scheduler walks past rows the first one already holds instead of blocking on them.

The jitter — `min(300s, 20% of the poll interval)` — exists because feeds registered
together otherwise stay in lockstep forever and every interval produces a thundering herd.

**Dispatch is BullMQ over Redis.** Scheduler-issued jobs use the stable id `feed-<id>`, so
one tick can never queue the same feed twice. Manual `check-now` jobs get a unique id
instead, so an operator's explicit request is never silently swallowed by deduplication
against a scheduled job.

**Recovery is a sweep that runs first.** Every tick calls `ReleaseStuckFeedsUseCase` before
claiming. A worker that dies between claim and fetch leaves `claimed_at` set and
`next_check_at` already pushed forward; without the sweep the feed disappears for a whole
poll interval. `SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS` (default 300) must stay above the
worst-case job duration, `RATE_LIMIT_MAX_BACKOFF_MS + FETCH_TIMEOUT_MS` — set it lower and
the sweep releases feeds that are still being fetched, causing duplicate outbound requests.

The tick is also re-entrancy guarded: a tick that outruns `SCHEDULER_TICK_MS` is not
overlapped by the next one, and shutdown awaits the in-flight tick so it can never enqueue
into a closing queue.

## Consequences

**Good.** Correct under concurrency without a distributed lock service. Retries, backoff and
queue-depth metrics come from BullMQ. The worker scales horizontally by replica count and
`WORKER_CONCURRENCY`, independently of the scheduler.

**Bad.** Redis becomes a required dependency, and its availability is the ingestion path's
availability. Job state and feed state live in two systems, so a Redis flush loses in-flight
jobs — recovered on the next tick, because the claim sweep releases them, but not instantly.
`claimed_at` is a second piece of state that every write path must clear (it is reset on
both the success and the failure path of `updateAfterFetch`).

**Rejected as a scaling lever:** running several schedulers. The claim is safe under
concurrency, but more schedulers only add contention on the same rows. Scale the worker.

## Alternatives considered

- **Cron plus a `SELECT … WHERE next_check_at <= NOW()`.** Rejected: two replicas both read
  the same rows before either writes.
- **`pg_cron` / a PostgreSQL-only queue.** Rejected: it would remove Redis, but the inbound
  rate limiter and BullMQ's retry/observability would have to be rebuilt on top of Postgres,
  and polling a table for jobs reintroduces the latency the queue removes.
- **A cloud queue (SQS, Pub/Sub).** Rejected: this ships as a self-hostable Compose stack on
  a single VPS. A managed queue would make the smoke and benchmark harnesses impossible to
  run locally.
