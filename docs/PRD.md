
# 📄 PRD — Plataforma de Monitorización de RSS a Escala (10.000 feeds)

## 1. Objetivo

Construir un sistema capaz de:

* Monitorizar **10.000 feeds RSS/Atom**
* Detectar nuevos items en tiempo casi real
* Aplicar **reglas/keywords**
* Generar **alertas automatizadas**
* Exponer API + panel de control

---

## 2. Alcance

### Incluido (MVP serio)

* Ingesta RSS/Atom
* Polling adaptativo
* Detección de nuevos items
* Sistema de reglas (keywords)
* Notificaciones (email/webhook)
* API REST
* Panel básico
* Observabilidad mínima

### No incluido (fase posterior)

* NLP pesado / embeddings
* clustering semántico
* UI avanzada
* multi-tenant complejo (aunque se deja preparado)

---

## 3. Requisitos funcionales

### 3.1 Gestión de feeds

* Añadir / eliminar feeds
* Activar / desactivar
* Tracking de salud (errores, latencia)

### 3.2 Ingesta

* Polling periódico
* Soporte ETag / Last-Modified
* Backoff automático

### 3.3 Procesamiento

* Parse RSS/Atom
* Normalización
* Deduplicación

### 3.4 Reglas

* Keywords (include/exclude)
* matching en:

  * título
  * descripción
* triggers

### 3.5 Alertas

* Email
* Webhook
* (futuro: Telegram/Slack)

### 3.6 Observabilidad

* feeds caídos
* error rate
* throughput
* latencia media

---

## 4. Requisitos no funcionales

| Requisito           | Valor                        |
| ------------------- | ---------------------------- |
| Escala              | 10.000 feeds                 |
| Latencia            | 5–30 min según feed          |
| Disponibilidad      | 99%                          |
| Persistencia        | Postgres                     |
| Concurrencia        | 100–300 requests simultáneos |
| Tolerancia a fallos | retry + backoff              |

---

## 5. Arquitectura

### 5.1 Componentes

```text
Scheduler → Queue → Workers → DB → Rules → Alerts
                         ↓
                      Metrics
```

### 5.2 Servicios

* **Scheduler**
* **Queue (Redis)**
* **Workers async**
* **PostgreSQL**
* **API**
* **Notifier**

---

## 6. Diseño de Base de Datos

### 6.1 Tabla: feeds

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

CREATE INDEX idx_feeds_next_check ON feeds(next_check_at);
```

---

### 6.2 Tabla: entries

```sql
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

CREATE INDEX idx_entries_feed ON entries(feed_id);
CREATE INDEX idx_entries_published ON entries(published_at DESC);
```

---

### 6.3 Tabla: fetch_logs

```sql
CREATE TABLE fetch_logs (
    id BIGSERIAL PRIMARY KEY,
    feed_id INT REFERENCES feeds(id),

    status_code INT,
    response_time_ms INT,

    error BOOLEAN,
    error_message TEXT,

    created_at TIMESTAMP DEFAULT NOW()
);
```

---

### 6.4 Tabla: rules

```sql
CREATE TABLE rules (
    id SERIAL PRIMARY KEY,

    name TEXT,
    include_keywords TEXT[],
    exclude_keywords TEXT[],

    is_active BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMP DEFAULT NOW()
);
```

---

### 6.5 Tabla: alerts

```sql
CREATE TABLE alerts (
    id BIGSERIAL PRIMARY KEY,

    entry_id BIGINT REFERENCES entries(id),
    rule_id INT REFERENCES rules(id),

    sent BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_alerts_created ON alerts(created_at DESC);
```

---

## 7. API (REST)

### 7.1 Feeds

```http
POST /feeds
GET /feeds
GET /feeds/{id}
DELETE /feeds/{id}
PATCH /feeds/{id}
```

#### Crear feed

```json
{
  "url": "https://example.com/rss",
  "poll_interval_seconds": 1800
}
```

---

### 7.2 Entries

```http
GET /entries
GET /entries?feed_id=1
GET /entries?search=keyword
```

---

### 7.3 Rules

```http
POST /rules
GET /rules
PATCH /rules/{id}
DELETE /rules/{id}
```

```json
{
  "name": "AI noticias",
  "include_keywords": ["AI", "LLM"],
  "exclude_keywords": ["crypto"]
}
```

---

### 7.4 Alerts

```http
GET /alerts
POST /alerts/{id}/send
```

---

### 7.5 Health

```http
GET /health
GET /metrics
```

---

## 8. Lógica de Scheduler

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

---

## 9. Worker (core)

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

---

## 10. Estrategia de polling

### Adaptativo

| Estado feed | Intervalo           |
| ----------- | ------------------- |
| Muy activo  | 5–10 min            |
| Normal      | 15–30 min           |
| Inactivo    | 1–3 h               |
| Error       | backoff exponencial |

---

## 11. Dedupe

Orden de prioridad:

1. `guid`
2. `link`
3. `content_hash`

```python
hash = sha256(title + link + published)
```

---

## 12. Notificaciones

### Estrategia

* batch opcional
* envío inmediato para MVP

### Webhook

```json
POST /webhook

{
  "title": "...",
  "link": "...",
  "rule": "AI noticias"
}
```

---

## 13. Observabilidad

Métricas clave:

* feeds activos vs caídos
* error rate por dominio
* tiempo medio de fetch
* entries/min
* alertas generadas

---

## 14. Seguridad

* rate limit API
* validación URLs feeds
* timeout agresivo en workers
* sanitización HTML

---

## 15. Despliegue

### Docker Compose

Servicios:

* app (API + scheduler)
* workers
* postgres
* redis

---

## 16. Estimación de recursos

### Recomendado

* 8 vCPU
* 16 GB RAM
* 240 GB NVMe

### Distribución

| Servicio | RAM    |
| -------- | ------ |
| Postgres | 4–8 GB |
| Redis    | 1–2 GB |
| Workers  | 4–8 GB |
| API      | 1 GB   |

---

## 17. Riesgos

| Riesgo         | Mitigación           |
| -------------- | -------------------- |
| Feeds rotos    | parser tolerante     |
| Duplicados     | hashes + constraints |
| Caídas masivas | circuit breaker      |
| Sobrecarga     | rate limit + cola    |

---

## 18. Roadmap

### Fase 1 (MVP)

* ingestión
* dedupe
* reglas simples
* alertas

### Fase 2

* multi-tenant
* UI
* métricas avanzadas

### Fase 3

* NLP
* clustering
* embeddings

---

## 19. Decisiones clave (sin postureo)

* Postgres > NoSQL → consistencia + joins
* Redis → suficiente para cola
* Async I/O → clave para escala
* polling adaptativo → obligatorio

---

## 20. Siguientes pasos

Te recomiendo hacer ahora:

1. **docker-compose base**
2. **migraciones SQL**
3. **worker mínimo funcional**
4. **scheduler simple**
5. **1 feed → test end-to-end**
6. escalar a 100 → 1.000 → 10.000

---


