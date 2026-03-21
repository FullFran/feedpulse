# FeedPulse — RSS Feed Monitoring Platform

A production-ready RSS monitoring platform with a clean DDD/Hexagonal architecture, three independent runtimes, and full observability. FeedPulse polls RSS/Atom feeds on a configurable schedule, matches entries against user-defined rules, fires webhook notifications, and exposes a real-time operator dashboard.

---

## Features

### Core Monitoring
- **Feed Registration & Management** — CRUD API for RSS/Atom feeds with name, URL, polling interval, and active/disabled state
- **Scheduled Polling** — BullMQ-scheduled background jobs that wake the worker exactly when a feed is due, using a domain-level rate limiter to respect each feed's host
- **Content Ingestion** — Full RSS/Atom/JSON Feed parsing via `rss-parser`; deduplication by GUID; pagination of large archives
- **On-Demand Check** — `POST /api/v1/feeds/:id/check-now` to force an immediate poll (bypasses scheduler)

### Alerting & Rules
- **Rule Engine** — CRUD API for alert rules with `field` (title/content/matchType), `operator` (contains/equals/regex), and `value` patterns; rules belong to a feed
- **Alert Delivery** — When entries match rules, alert jobs are queued for reliable delivery with automatic retries
- **Webhook Notifier** — HTTP POST of each alert payload (feed ID, rule ID, entry title/URL/content, timestamp) to a configured `WEBHOOK_NOTIFIER_URL`; falls back to no-op when unset

### Observability
- **Health & Readiness** — `GET /health` (liveness) and `GET /ready` (Postgres + Redis connectivity check)
- **Prometheus Metrics** — `GET /metrics` with feed fetch latency, queue depths, alert delivery counts, and HTTP agent stats via `prom-client`
- **Operator Dashboard** — Static HTML dashboard at `/dashboard/` with feed/rule/alert overview tables and quick-action buttons

### API & Documentation
- **REST API** — Versioned at `/api/v1/` with full CRUD for feeds, entries, rules, and alerts; list endpoints support pagination (`limit`, `cursor`)
- **Swagger UI** — Interactive docs at `/docs`; OpenAPI JSON at `/docs-json`

### Three Runtimes
| Process | Purpose |
|---------|---------|
| `api` | HTTP server — REST API + Swagger + dashboard |
| `scheduler` | Cron-like runner — enqueues feed-fetch jobs when feeds become due |
| `worker` | Job processor — fetches feeds, evaluates rules, enqueues alert deliveries |

---

## Architecture

```
src/
├── main/                  # Runtime entry points (api.ts, scheduler.ts, worker.ts)
├── modules/
│   ├── feeds/             # Feed entity, repository, CRUD use-cases, HTTP controller
│   ├── entries/           # Entry entity, repository, list use-case, HTTP controller
│   ├── rules/             # Rule entity, repository, CRUD use-cases, HTTP controller
│   ├── alerts/            # Alert entity, repository, delivery use-cases, HTTP controller
│   ├── ingestion/         # FeedFetcher port, domain rate-limiter, job processor
│   ├── notifications/      # AlertNotifier port, WebhookNotifier adapter
│   └── observability/      # Health, readiness, Prometheus metrics
├── infrastructure/
│   ├── persistence/       # PostgreSQL via pg, raw SQL migrations
│   └── queue/             # BullMQ adapters for fetch-feed and alert-delivery queues
└── shared/
    ├── config/            # Zod-validated environment config
    ├── http/               # Swagger setup, response helpers
    └── logging/           # Pino logger module
```

- **Ports & Adapters** — `FeedFetcherPort` and `AlertNotifierPort` are interfaces; concrete adapters live in `infrastructure/`
- **Use-Case Layer** — All business logic lives in `application/` use-case classes, keeping controllers thin
- **Database** — Raw SQL with `pg`; migrations applied via `npm run migrate`; `pg-mem` for unit tests

---

## Tech Stack

- **Runtime**: Node.js 22 + TypeScript 5
- **HTTP**: NestJS + `@nestjs/swagger`
- **Database**: PostgreSQL + `pg`
- **Queue**: BullMQ + Redis
- **HTTP Client**: `http`/`https` agents with per-host rate limiting
- **RSS Parsing**: `rss-parser`
- **Validation**: `class-validator` + `zod`
- **Metrics**: `prom-client`
- **Tests**: Jest + `pg-mem` + `supertest`

---

## Getting Started

### Prerequisites

- Node.js 22+
- Docker & Docker Compose
- PostgreSQL 15+ and Redis 7+

### 1. Clone & Install

```bash
git clone https://github.com/franblakia/feedpulse.git
cd feedpulse
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your database/Redis/GitHub credentials
```

Key variables:
| Variable | Description |
|----------|-------------|
| `POSTGRES_HOST` | PostgreSQL host |
| `POSTGRES_PORT` | PostgreSQL port |
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | DB credentials |
| `REDIS_HOST` | Redis host |
| `REDIS_PORT` | Redis port |
| `WEBHOOK_NOTIFIER_URL` | Webhook endpoint for alerts (optional) |
| `API_PORT` | HTTP server port (default 3000) |

### 3. Run Migrations

```bash
npm run migrate
```

### 4. Start the Stack

```bash
# All three runtimes + Postgres + Redis
docker compose up -d --build

# Or run locally (requires Postgres and Redis)
npm run start:api      # Terminal 1
npm run start:scheduler # Terminal 2
npm run start:worker   # Terminal 3
```

### 5. Verify

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Liveness check |
| `GET /ready` | Readiness check (DB + Redis) |
| `GET /metrics` | Prometheus metrics |
| `GET /docs` | Swagger UI |
| `GET /dashboard/` | Operator dashboard |

---

## API Reference

### Feeds

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/feeds` | Register a new feed |
| `GET` | `/api/v1/feeds` | List all feeds |
| `GET` | `/api/v1/feeds/:id` | Get a feed |
| `PATCH` | `/api/v1/feeds/:id` | Update a feed |
| `DELETE` | `/api/v1/feeds/:id` | Disable a feed |
| `POST` | `/api/v1/feeds/:id/check-now` | Trigger immediate poll |

### Entries

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/feeds/:id/entries` | List entries for a feed |

### Rules

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/feeds/:feedId/rules` | Create a rule |
| `GET` | `/api/v1/feeds/:feedId/rules` | List rules for a feed |
| `GET` | `/api/v1/rules/:id` | Get a rule |
| `PATCH` | `/api/v1/rules/:id` | Update a rule |
| `DELETE` | `/api/v1/rules/:id` | Disable a rule |

### Alerts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/alerts` | List all alerts |
| `GET` | `/api/v1/alerts/:id` | Get an alert |
| `POST` | `/api/v1/alerts/:id/send` | Retry sending an alert |

---

## Testing

```bash
# Unit + integration tests (fake BullMQ queue)
npm test

# Integration tests against a real stack
npm run smoke:ci

# Capacity benchmarks
npm run benchmark:stage:100:safe   # 100 feeds
npm run benchmark:stages:mvp       # 100 → 10,000 feeds
```

---

## License

MIT
