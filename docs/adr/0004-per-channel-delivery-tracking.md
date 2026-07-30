# ADR 0004 — Per-channel delivery state on the alert row

**Status:** accepted · **Applies to:** migration 0013; `src/modules/alerts/application/process-alert-delivery.use-case.ts`

## Context

An alert can be delivered through three independent channels: a tenant webhook, email via
Resend, and Telegram. They fail independently — a webhook endpoint returns 500 while
Telegram is fine, a tenant exhausts its daily email quota while the webhook succeeds.

The original model carried a single aggregate `delivery_status`. That made retries wrong in
the only way that matters to a user: re-driving an alert because Telegram failed also
re-sent the webhook that had already succeeded. The more reliable your retry policy, the
more duplicates it produced.

## Decision

Migration 0013 adds three columns to `alerts`, each constrained to
`pending | sent | failed`:

- `webhook_delivery_status`
- `telegram_delivery_status`
- `email_delivery_status`

The aggregate `delivery_status` stays as the operator-facing summary
(`pending | queued | retrying | sent | failed | disabled`), but it is no longer what the
delivery logic branches on.

`ProcessAlertDeliveryUseCase` decides per channel: a channel is attempted only if it is
configured for the tenant **and** its own status is not already `sent`. Each success marks
that channel alone. The job is therefore idempotent per channel, and
`POST /api/v1/alerts/:id/send` is safe to call as many times as an operator likes.

Failures are split into two kinds, which matters because they need opposite handling:

- **Retryable** — an HTTP 500 from a webhook, a Telegram timeout. Recorded and re-raised so
  BullMQ retries the job.
- **Terminal** — the tenant's daily email quota is exhausted. Retrying today cannot help.
  The channel is marked `failed` with the reason (`quota_exceeded`), the alert is left
  re-drivable once the day rolls over, and the job is not retried into the same wall.

Each channel also gets a partial index —
`(id, tenant_id) WHERE <channel>_delivery_status = 'pending'` — so "what still needs
delivering on this channel" scans the backlog rather than the table.

## Consequences

**Good.** No duplicate deliveries on retry. `rss_alert_delivery_channel_failures_total{channel}`
is meaningful per channel, so a single broken integration is visible instead of being
averaged into an overall failure rate. A tenant hitting its email quota still gets webhook
and Telegram alerts.

**Bad.** Four status fields on one row instead of one, and the aggregate can look
inconsistent with the three parts if a future channel is added without updating the roll-up.
Adding a fourth channel means a migration, a column, a check constraint and a partial index
— it is not free.

## Alternatives considered

- **An `alert_deliveries` child table**, one row per `(alert_id, channel, attempt)`. Strictly
  more expressive and the right answer if per-attempt history is ever needed. Rejected for
  now: it makes the hot path a join and a second write on every alert, and nothing in the
  product currently reads attempt history. This ADR is the cheap 90% of it, and the child
  table remains the documented upgrade path.
- **A `jsonb` status object.** Rejected: no check constraints, no partial indexes, and every
  reader would have to agree on an unenforced shape.
