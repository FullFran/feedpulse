# Deploying to Dokploy with Docker Compose

FeedPulse runs on a single VPS through [Dokploy](https://dokploy.com) using
`compose.dokploy.yml` at the repository root. This is the deployment path the project is
actually operated on; the root `docker-compose.yml` is for local development.

## 1. Create the service

1. In Dokploy, create a **Compose** service.
2. Connect this Git repository.
3. Select `compose.dokploy.yml`.
4. Enable **Isolated Deployments**.

## 2. Environment

Use `.env.example` as the template and paste the values into Dokploy's **Environment** tab.
Every variable is parsed and validated at startup by `src/shared/config/env.schema.ts`; a
malformed value fails the boot rather than silently degrading. Note that a key the schema
does not declare is stripped rather than rejected, so a misspelled variable name is inert,
not fatal — check the spelling against the table below.

The variables that must be set for a real deployment:

| Variable                                            | Notes                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                          | `production`. This activates the refinement that refuses to boot with auth off.                                 |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Consumed by the `postgres` service in the compose file.                                                         |
| `DATABASE_URL`                                      | Internal host: `postgres://<user>:<password>@postgres:5432/<db>`.                                               |
| `REDIS_URL`                                         | Internal host: `redis://redis:6379`.                                                                            |
| `ENABLE_AUTH`                                       | `true`. Required in production.                                                                                 |
| `AUTH_PROVIDER`                                     | `api_key`, `clerk` or `clerk_api_key`.                                                                          |
| `BOOTSTRAP_API_KEY`                                 | Seeded into `api_keys` by the migration step. **Change it before exposing the API.**                            |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`         | Only when `AUTH_PROVIDER` includes `clerk`.                                                                     |
| `TENANT_SECRETS_MASTER_KEY`                         | Optional. Required only if tenants store their own Telegram bot token. Generate with `openssl rand -base64 32`. |
| `CORS_ORIGINS`                                      | Comma-separated browser origins. Empty disables CORS entirely.                                                  |
| `METRICS_AUTH_TOKEN`                                | Set it. Without it `/metrics` is open.                                                                          |

Leave `ALLOW_PRIVATE_FEED_HOSTS=false` in production. It disables the SSRF host checks and
exists for self-hosted homelab feeds and for the docker smoke stack only.

## 3. Domain and HTTPS

1. In the **Domains** tab, add the public domain.
2. Point it at the `api` service on internal port `3000`.
3. Set **`TRAEFIK_HOST`** in the environment to that same domain.

`TRAEFIK_HOST` feeds the Traefik router rule in `compose.dokploy.yml`:

```yaml
- traefik.http.routers.feedpulse-api.rule=Host(`${TRAEFIK_HOST:-feedpulse.localhost}`)
```

Leave it unset and the router answers only on `feedpulse.localhost`, so the service will
appear deployed but unreachable from your domain. It is a variable rather than a literal on
purpose: a hardcoded hostname makes this file unusable by anyone else, and publishes the
address of whoever committed it.

The compose file uses `expose: 3000` rather than a host port publication, so Traefik routes
by domain without any manual port mapping.

## 4. Persistence

Two named volumes survive redeploys:

- `postgres_data`
- `redis_data`

Avoid `container_name` and relative bind mounts — both break Dokploy's isolated deployments.

## 5. Deploy

1. Run **Deploy** from Dokploy.
2. Check the logs: `api`, `scheduler` and `worker` should all reach a healthy state. The
   `api` container runs `node dist/scripts/migrate.js` before starting the server, so its
   readiness probe has a long start period — a first deployment applies every migration
   before it can answer.
3. Verify:
   - `GET /health` — liveness.
   - `GET /ready` — PostgreSQL, Redis and schema readiness.
   - `GET /docs` — only if `ENABLE_SWAGGER=true`; it defaults to **off** in production.

## 6. After the first deploy

Replace the bootstrap credential with a real one:

```bash
npm run apikey:create -- --tenant <tenant-id> --label <where-it-is-used>
```

The plaintext key is printed once and cannot be recovered. Revoking a key sets
`api_keys.revoked_at`; the lookup index is partial on `revoked_at IS NULL`, so revocation
takes effect immediately.

## Notes

- Migrations run at container start, not at application boot, and are serialized by a
  PostgreSQL advisory lock — several replicas starting together is safe.
- Migrations are append-only and checksummed. Editing one that has already run will fail
  the next deploy with `MIGRATION_CHECKSUM_MISMATCH` rather than corrupting the schema.
- The `scheduler` service has no HTTP surface, so its healthcheck is disabled rather than
  faked. The `worker` service is probed on its own metrics port instead of the API port.
