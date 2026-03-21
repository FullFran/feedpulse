# Plan de API REST - MVP

## 1. Objetivo

Este documento define el contrato esperado de la API REST del MVP. Se toma el PRD como fuente de verdad y se expande hacia una planificacion implementable para gestion de feeds, consulta de entries, administracion de reglas, inspeccion de alertas y endpoints operativos.

## 2. Principios de la API

- API JSON sobre HTTP.
- Versionado recomendado por prefijo: `/api/v1`.
- Contratos consistentes para exito, error, filtros y paginacion.
- Endpoints orientados al MVP operativo, sin exponer capacidades de fase futura.
- Salud y metricas expuestas separadamente para operacion y observabilidad.

## 3. Alcance MVP vs fase futura

### MVP

- CRUD basico de feeds.
- Consulta de entries con filtros simples.
- CRUD basico de rules.
- Consulta de alerts y accion de reenvio manual.
- `GET /health` y `GET /metrics`.

### Fase futura

- Autenticacion/autorizacion por usuario o tenant.
- Busqueda avanzada full-text.
- Canales extra de notificacion.
- Bulk operations y acciones masivas.
- Webhooks de administracion y eventos de dominio.

## 4. Convenciones transversales

### Base path

```text
/api/v1
```

### Headers recomendados

- `Content-Type: application/json`
- `Accept: application/json`
- `X-Request-Id` opcional para trazabilidad

### Descubribilidad de contrato

- Swagger UI disponible en `/docs` para inspeccion manual del contrato expuesto por la API.
- OpenAPI JSON disponible en `/docs-json` para integraciones, tests de humo y clientes generados.

### Formato de respuesta exitosa

```json
{
  "data": {},
  "meta": {
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

### Formato de lista paginada

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "page_size": 50,
    "total": 1250,
    "has_next": true,
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

### Formato de error

```json
{
  "error": {
    "code": "feed_invalid_url",
    "message": "La URL del feed no es valida",
    "details": {
      "field": "url"
    }
  },
  "meta": {
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

## 5. Recursos y contratos

### 5.1 Feeds

#### `POST /api/v1/feeds`

Alta de un feed para monitorizacion.

Request:

```json
{
  "url": "https://example.com/rss",
  "poll_interval_seconds": 1800,
  "status": "active"
}
```

Validaciones MVP:

- `url` obligatoria, esquema `http` o `https`.
- `poll_interval_seconds` opcional, rango recomendado entre 300 y 10800.
- `status` opcional, default `active`.

Response `201 Created`:

```json
{
  "data": {
    "id": 101,
    "url": "https://example.com/rss",
    "status": "active",
    "poll_interval_seconds": 1800,
    "next_check_at": "2026-03-20T10:30:00Z",
    "error_count": 0,
    "created_at": "2026-03-20T10:00:00Z"
  },
  "meta": {
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

Errores esperados:

- `400` `feed_invalid_url`
- `409` `feed_already_exists`
- `422` `feed_invalid_poll_interval`

#### `GET /api/v1/feeds`

Lista feeds con filtros operativos.

Filtros MVP:

- `status=active|paused|error`
- `q=<texto>` para coincidencia parcial sobre URL
- `next_check_before=<timestamp>`
- `page`, `page_size`
- `sort=created_at|next_check_at|last_checked_at`
- `order=asc|desc`

Response `200 OK`:

```json
{
  "data": [
    {
      "id": 101,
      "url": "https://example.com/rss",
      "status": "active",
      "next_check_at": "2026-03-20T10:30:00Z",
      "last_checked_at": "2026-03-20T10:00:00Z",
      "error_count": 0
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 50,
    "total": 1,
    "has_next": false,
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

#### `GET /api/v1/feeds/{id}`

Devuelve detalle operativo de un feed.

Campos recomendados:

- estado actual
- metadatos HTTP (`etag`, `last_modified`)
- timestamps de polling
- metricas simples (`avg_response_ms`, `avg_items_per_day`)
- ultimo error si existe

Errores esperados:

- `404` `feed_not_found`

#### `PATCH /api/v1/feeds/{id}`

Actualiza configuracion operativa.

Campos editables MVP:

- `status`
- `poll_interval_seconds`

Request ejemplo:

```json
{
  "status": "paused",
  "poll_interval_seconds": 3600
}
```

Errores esperados:

- `400` `feed_invalid_status`
- `404` `feed_not_found`
- `422` `feed_invalid_poll_interval`

#### `DELETE /api/v1/feeds/{id}`

Elimina un feed del catalogo.

Decision MVP:

- Exponer borrado fisico solo si no rompe trazabilidad requerida.
- Recomendacion de implementacion: traducir a desactivacion logica o exigir una bandera futura `hard_delete` fuera de MVP.

Response `204 No Content`.

### 5.2 Entries

#### `GET /api/v1/entries`

Lista entries detectadas.

Filtros MVP:

- `feed_id`
- `search` sobre `title` y `content` con matching simple
- `published_from`
- `published_to`
- `page`, `page_size`
- `sort=published_at|fetched_at`
- `order=asc|desc`

Response `200 OK`:

```json
{
  "data": [
    {
      "id": 9001,
      "feed_id": 101,
      "title": "Nueva noticia",
      "link": "https://example.com/item/1",
      "guid": "item-1",
      "published_at": "2026-03-20T09:45:00Z",
      "fetched_at": "2026-03-20T10:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 50,
    "total": 1,
    "has_next": false,
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

Errores esperados:

- `400` `entries_invalid_filter`

Decision MVP:

- No crear `GET /entries/{id}` porque el PRD no lo exige; puede agregarse despues si el panel lo necesita.

### 5.3 Rules

#### `POST /api/v1/rules`

Crea una regla activa para matching por keywords.

Request:

```json
{
  "name": "AI noticias",
  "include_keywords": ["AI", "LLM"],
  "exclude_keywords": ["crypto"],
  "is_active": true
}
```

Validaciones MVP:

- `name` obligatorio.
- Al menos un valor en `include_keywords`.
- Limitar longitud y cantidad de keywords para proteger rendimiento.

Response `201 Created` con la regla creada.

Errores esperados:

- `400` `rule_invalid_payload`
- `422` `rule_missing_include_keywords`

#### `GET /api/v1/rules`

Lista reglas.

Filtros MVP:

- `is_active=true|false`
- `q=<texto>` sobre nombre
- `page`, `page_size`

#### `PATCH /api/v1/rules/{id}`

Actualiza nombre, keywords y estado.

Errores esperados:

- `404` `rule_not_found`
- `422` `rule_invalid_keywords`

#### `DELETE /api/v1/rules/{id}`

Elimina o desactiva una regla segun politica final del dominio.

Decision MVP:

- Preferible desactivacion logica si las alertas historicas deben seguir referenciando la regla.

### 5.4 Alerts

#### `GET /api/v1/alerts`

Lista alertas generadas por coincidencia de reglas.

Filtros MVP:

- `rule_id`
- `entry_id`
- `sent=true|false`
- `created_from`
- `created_to`
- `page`, `page_size`
- `sort=created_at`
- `order=asc|desc`

Response recomendada:

```json
{
  "data": [
    {
      "id": 5001,
      "sent": false,
      "created_at": "2026-03-20T10:00:02Z",
      "entry": {
        "id": 9001,
        "title": "Nueva noticia",
        "link": "https://example.com/item/1"
      },
      "rule": {
        "id": 12,
        "name": "AI noticias"
      }
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 50,
    "total": 1,
    "has_next": false,
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

#### `POST /api/v1/alerts/{id}/send`

Fuerza reenvio manual de una alerta.

Decision MVP:

- La operacion debe ser idempotente desde la capa de negocio.
- Si existe cola de notificaciones, este endpoint solo encola el trabajo.

Response `202 Accepted`:

```json
{
  "data": {
    "id": 5001,
    "status": "queued"
  },
  "meta": {
    "request_id": "req_123",
    "timestamp": "2026-03-20T10:00:00Z"
  }
}
```

Errores esperados:

- `404` `alert_not_found`
- `409` `alert_send_in_progress`

## 6. Endpoints operativos

### `GET /health`

Uso: health check para orquestador y monitoreo externo.

Response minima `200 OK`:

```json
{
  "status": "ok",
  "checks": {
    "api": "ok",
    "postgres": "ok",
    "redis": "ok"
  },
  "timestamp": "2026-03-20T10:00:00Z"
}
```

Decision MVP:

- Si una dependencia critica falla, responder `503 Service Unavailable`.
- No incluir diagnostico profundo ni informacion sensible.

### `GET /metrics`

Uso: scrape de Prometheus.

Formato recomendado:

- `Content-Type: text/plain; version=0.0.4`
- No JSON en este endpoint.

Metricas MVP alineadas con el PRD:

- `rss_feeds_active_total`
- `rss_feeds_error_total`
- `rss_fetch_duration_ms`
- `rss_fetch_errors_total`
- `rss_entries_ingested_total`
- `rss_alerts_generated_total`
- `rss_alerts_sent_total`

## 7. Paginacion y filtros

### Regla general

- Default `page=1`
- Default `page_size=50`
- Maximo `page_size=200`

### Criterios

- Paginacion por offset es suficiente para el MVP.
- Si la carga real lo exige, evolucionar a cursor pagination en fase futura.
- Validar filtros de fecha en formato ISO-8601 UTC.

## 8. Matriz de errores

| HTTP | Code | Caso |
| --- | --- | --- |
| 400 | `bad_request` | JSON invalido o query string mal formada |
| 400 | `invalid_filter` | Filtro no soportado o valor invalido |
| 404 | `feed_not_found` | Feed inexistente |
| 404 | `rule_not_found` | Regla inexistente |
| 404 | `alert_not_found` | Alerta inexistente |
| 409 | `feed_already_exists` | URL duplicada |
| 409 | `alert_send_in_progress` | Reenvio ya en curso |
| 422 | `validation_error` | Violacion de reglas de dominio |
| 429 | `rate_limited` | Limite de peticiones alcanzado |
| 500 | `internal_error` | Fallo inesperado |
| 503 | `service_unavailable` | Dependencia critica caida |

## 9. Seguridad y protecciones MVP

- Rate limiting por IP o token de sistema.
- Validacion estricta de URLs al crear feeds.
- Sanitizacion de texto devuelto por entries si se reutiliza en panel web.
- Timeouts y cancellation en handlers para evitar consumo excesivo.
- Logs estructurados sin exponer secretos ni payloads sensibles.

## 10. Observabilidad de la API

- Cada request debe producir log estructurado con `request_id`, endpoint, status y latencia.
- Exponer histogramas de latencia por endpoint.
- Contar errores por codigo de negocio y por status HTTP.
- Medir tamano de pagina y frecuencia de filtros para futuras optimizaciones.

## 11. Checklist de implementacion

- Definir `OpenAPI` o contrato equivalente a partir de este documento.
- Unificar envelopes `data/meta` y `error/meta`.
- Implementar validaciones de URL, rangos y enums.
- Agregar middleware de `request_id`, rate limiting y logging.
- Exponer `/health` y `/metrics` fuera del namespace versionado si la plataforma lo requiere.
- Confirmar politica final para `DELETE` logico vs fisico en feeds y rules.

## 12. Estado de readiness

La planificacion es suficiente para construir la API REST del MVP con contratos claros, filtros operativos, manejo de errores, paginacion y endpoints de salud y metricas. Quedan como decisiones de cierre de implementacion el enfoque exacto de borrado y la especificacion final en OpenAPI.
