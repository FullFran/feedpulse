# Archived: original product brief

> **This is history, not a specification.**
>
> This is the product brief the project started from, written before any code existed. The
> file name keeps the `-es` suffix because the original was written in Spanish; the text
> below is the English translation, kept so the repository speaks one language.
>
> Large parts of it have been superseded. It predates multi-tenancy, API-key authentication,
> the OPML import pipeline, Telegram delivery, the canonical-link alert dedupe, per-channel
> delivery tracking and the SSRF containment layer. The table definitions below are **not**
> the current schema.
>
> For what the system actually is today, read [`../architecture.md`](../architecture.md),
> [`../api.md`](../api.md) and [`../database.md`](../database.md).

---

## 1. Goal

Build a system capable of:

- Monitoring **10,000 RSS/Atom feeds**
- Detecting new items in near real time
- Applying **rules / keywords**
- Generating **automated alerts**
- Exposing an API plus a control panel

## 2. Scope

### In scope (serious MVP)

- RSS/Atom ingestion
- Adaptive polling
- New-item detection
- Rule system (keywords)
- Notifications (email / webhook)
- REST API
- Basic panel
- Minimal observability

### Out of scope (later phase)

- Heavy NLP / embeddings
- Semantic clustering
- Advanced UI
- Complex multi-tenancy (though the design leaves room for it)

## 3. Functional requirements

### 3.1 Feed management

- Add / remove feeds
- Enable / disable
- Health tracking (errors, latency)

### 3.2 Ingestion

- Periodic polling
- ETag / Last-Modified support
- Automatic backoff

### 3.3 Processing

- RSS/Atom parsing
- Normalization
- Deduplication

### 3.4 Rules

- Keywords (include / exclude)
- Matching over the title and the description
- Triggers

### 3.5 Alerts

- Email
- Webhook
- (later: Telegram / Slack)

### 3.6 Observability

- Down feeds
- Error rate
- Throughput
- Average latency

## 4. Non-functional requirements

| Requirement     | Target                        |
| --------------- | ----------------------------- |
| Scale           | 10,000 feeds                  |
| Latency         | 5–30 min depending on feed    |
| Availability    | 99%                           |
| Persistence     | PostgreSQL                    |
| Concurrency     | 100–300 simultaneous requests |
| Fault tolerance | Retry + backoff               |

## 5. Architecture

```text
Scheduler → Queue → Workers → DB → Rules → Alerts
                         ↓
                      Metrics
```

Services: Scheduler, Queue (Redis), async Workers, PostgreSQL, API, Notifier.

## 6. Original database sketch

> Superseded. The real schema is documented in [`../database.md`](../database.md) and built
> by `db/migrations/0001..0021`. Notably, every table below now carries `tenant_id`, `alerts`
> is keyed on a canonical article link rather than on `(entry_id, rule_id)`, and all
> timestamps are `TIMESTAMPTZ`.

```sql
CREATE TABLE feeds (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    status VARCHAR(20) DEFAULT 'active',
    etag TEXT,
    last_modified TEXT,
    last_checked_at TIMESTAMP,
    next_check_at TIMESTAMP,
    poll_interval_seconds INT DEFAULT 1800,
    error_count INT DEFAULT 0,
    last_error TEXT,
    avg_response_ms INT,
    avg_items_per_day FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE entries (
    id BIGSERIAL PRIMARY KEY,
    feed_id INT REFERENCES feeds(id),
    title TEXT,
    link TEXT,
    guid TEXT,
    content TEXT,
    content_hash TEXT NOT NULL,
    published_at TIMESTAMP,
    fetched_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(feed_id, guid),
    UNIQUE(feed_id, content_hash)
);

CREATE TABLE fetch_logs (
    id BIGSERIAL PRIMARY KEY,
    feed_id INT REFERENCES feeds(id),
    status_code INT,
    response_time_ms INT,
    error BOOLEAN,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    name TEXT,
    include_keywords TEXT[],
    exclude_keywords TEXT[],
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE alerts (
    id BIGSERIAL PRIMARY KEY,
    entry_id BIGINT REFERENCES entries(id),
    rule_id INT REFERENCES rules(id),
    sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## 7. Original API sketch

> Superseded by [`../api.md`](../api.md). The shipped API is versioned under `/api/v1`,
> requires authentication, and returns `data`/`meta` envelopes.

```http
POST   /feeds          GET /feeds        GET /feeds/{id}
PATCH  /feeds/{id}     DELETE /feeds/{id}
GET    /entries        GET /entries?feed_id=1     GET /entries?search=keyword
POST   /rules          GET /rules        PATCH /rules/{id}   DELETE /rules/{id}
GET    /alerts         POST /alerts/{id}/send
GET    /health         GET /metrics
```

## 8. Original scheduler sketch

```python
def scheduler_tick():
    feeds = db.query("""
        SELECT * FROM feeds
        WHERE next_check_at <= NOW()
        LIMIT 500
    """)

    for feed in feeds:
        queue.enqueue("fetch_feed", feed.id)
```

> This is exactly the design that was later replaced. A plain `SELECT` lets two schedulers
> read the same rows before either writes. The shipped version claims rows atomically with
> `UPDATE … FOR UPDATE SKIP LOCKED`; see [`../adr/0002-bullmq-over-cron.md`](../adr/0002-bullmq-over-cron.md).

## 9. Original worker sketch

```python
async def fetch_feed(feed_id):
    feed = get_feed(feed_id)

    response = await http_get(
        feed.url,
        headers={
            "If-None-Match": feed.etag,
            "If-Modified-Since": feed.last_modified
        }
    )

    if response.status == 304:
        update_next_check(feed)
        return

    items = parse_feed(response)
    new_entries = dedupe(items)
    save_entries(new_entries)
    apply_rules(new_entries)
    update_feed_metadata(feed, response)
```

> The shape survived; `http_get` did not. Fetching a stored URL directly is an SSRF vector,
> which is why the shipped worker goes through `safeFetch` with per-hop redirect
> revalidation and a streamed body cap.

## 10. Polling strategy

| Feed state  | Interval            |
| ----------- | ------------------- |
| Very active | 5–10 min            |
| Normal      | 15–30 min           |
| Inactive    | 1–3 h               |
| Error       | Exponential backoff |

## 11. Deduplication

Priority order: `guid`, then `link`, then `content_hash`, where
`hash = sha256(title + link + published)`.

## 12. Notifications

Immediate delivery for the MVP, optional batching later. Webhook payload:

```json
{ "title": "...", "link": "...", "rule": "AI news" }
```

## 13. Observability

Key metrics: active vs down feeds, error rate per domain, average fetch time, entries per
minute, alerts generated.

## 14. Security

API rate limiting, feed URL validation, aggressive worker timeouts, HTML sanitization.

## 15. Deployment

Docker Compose: `app` (API + scheduler), `workers`, `postgres`, `redis`.

> Superseded: the API and the scheduler now run as separate processes from the same image.

## 16. Resource estimate

Recommended: 8 vCPU, 16 GB RAM, 240 GB NVMe.

| Service    | RAM    |
| ---------- | ------ |
| PostgreSQL | 4–8 GB |
| Redis      | 1–2 GB |
| Workers    | 4–8 GB |
| API        | 1 GB   |

## 17. Risks

| Risk         | Mitigation           |
| ------------ | -------------------- |
| Broken feeds | Tolerant parser      |
| Duplicates   | Hashes + constraints |
| Mass outages | Circuit breaker      |
| Overload     | Rate limit + queue   |

## 18. Roadmap

- **Phase 1 (MVP):** ingestion, dedupe, simple rules, alerts
- **Phase 2:** multi-tenancy, UI, advanced metrics
- **Phase 3:** NLP, clustering, embeddings

## 19. Key decisions

- PostgreSQL over NoSQL — consistency and joins
- Redis — sufficient as a queue
- Async I/O — essential for scale
- Adaptive polling — mandatory

## 20. Original next steps

1. Base docker-compose
2. SQL migrations
3. Minimal working worker
4. Simple scheduler
5. One feed, end to end
6. Scale to 100 → 1,000 → 10,000
