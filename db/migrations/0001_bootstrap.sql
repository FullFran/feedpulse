CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  etag TEXT,
  last_modified TEXT,
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  poll_interval_seconds INT NOT NULL DEFAULT 1800,
  error_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  avg_response_ms INT,
  avg_items_per_day DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feeds_next_check_active
ON feeds (next_check_at)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS entries (
  id BIGSERIAL PRIMARY KEY,
  feed_id INT NOT NULL REFERENCES feeds(id),
  title TEXT,
  link TEXT,
  guid TEXT,
  content TEXT,
  content_hash TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feed_id, guid),
  UNIQUE (feed_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_entries_feed_published
ON entries (feed_id, published_at DESC);

CREATE TABLE IF NOT EXISTS fetch_logs (
  id BIGSERIAL PRIMARY KEY,
  feed_id INT NOT NULL REFERENCES feeds(id),
  status_code INT,
  response_time_ms INT,
  error BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fetch_logs_feed_created
ON fetch_logs (feed_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  include_keywords TEXT[] NOT NULL,
  exclude_keywords TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES entries(id),
  rule_id INT NOT NULL REFERENCES rules(id),
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entry_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_sent_created
ON alerts (sent, created_at DESC);
