# Local Smoke Flow

The project now includes a deterministic smoke harness that uses only local services. It does not depend on any public RSS feed or third-party webhook endpoint.

## Prerequisites

- `npm ci`
- `cp .env.example .env`
- Docker with `docker compose`

Leave `WEBHOOK_NOTIFIER_URL` empty in `.env`. The smoke override injects a local receiver only for the smoke stack.
The smoke scripts default to dedicated host ports so they can run beside the normal local stack.

## Run the smoke flow

```bash
npm run build
npm run smoke:stack:up
npm run smoke:stack:run
npm run smoke:stack:down
```

What the smoke runner proves:

- Docker services boot successfully.
- Explicit migrations succeed.
- `GET /health` and `GET /ready` return `200`.
- `GET /docs`, `GET /docs-json`, and `GET /dashboard/` respond correctly.
- A feed and rule can be seeded through the API.
- `POST /api/v1/feeds/:id/check-now` drives worker ingestion.
- A matching alert reaches `sent`.
- The local webhook receiver captures the notifier payload.

Artifacts are written to `artifacts/smoke/` so local failures and CI failures keep the same evidence.

## Ports

- API: `${SMOKE_API_HOST_PORT:-3300}`
- PostgreSQL: `${SMOKE_POSTGRES_HOST_PORT:-56432}`
- Redis: `${SMOKE_REDIS_HOST_PORT:-57379}`
- Smoke fixture and webhook receiver: `${SMOKE_MONITORING_PORT:-4010}`
