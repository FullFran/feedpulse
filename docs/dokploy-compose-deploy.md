# Despliegue en Dokploy con Docker Compose

Este proyecto puede desplegarse en un unico VPS usando Dokploy y el archivo
`compose.dokploy.yml`.

## 1) Crear servicio en Dokploy

1. En Dokploy crea un servicio tipo **Compose**.
2. Conecta el repositorio Git de este proyecto.
3. Selecciona el archivo `compose.dokploy.yml`.
4. Activa **Isolated Deployments**.

## 2) Variables de entorno

Usa `.env.example` como base y carga esas variables en la pestaña
**Environment** de Dokploy.

Variables clave:

- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `DATABASE_URL` (host interno `postgres`)
- `REDIS_URL` (host interno `redis`)
- `ENABLE_AUTH`, `CLERK_SECRET_KEY`, `CLERK_API_URL` (si aplica)

Ejemplo de URLs internas:

- `DATABASE_URL=postgres://postgres:change_me@postgres:5432/rss_monitor`
- `REDIS_URL=redis://redis:6379`

## 3) Dominio y trafico HTTPS

1. En la pestaña **Domains** agrega el dominio publico.
2. Apunta el dominio al servicio `api` en puerto interno `3000`.

El compose usa `expose: 3000` para que Traefik enrute por dominio sin abrir
puertos host manuales.

## 4) Persistencia

El stack define dos volumenes nombrados:

- `postgres_data`
- `redis_data`

Ambos persisten entre redeploys.

## 5) Deploy

1. Ejecuta **Deploy** desde Dokploy.
2. Verifica en logs que `api`, `scheduler` y `worker` queden en estado healthy.
3. Prueba endpoints:
   - `/health`
   - `/ready`
   - `/docs`

## Notas

- `api` corre migraciones al iniciar: `node dist/scripts/migrate.js`.
- Evita `container_name` y bind mounts relativos para no romper features de
  Dokploy y redeploys.
