-- Migration 0019: a replayable dead-letter store for permanently failed jobs.
--
-- Every queue in src/infrastructure/queue is configured with `removeOnFail: 100`.
-- That bound is deliberate (BullMQ would otherwise keep every failed job in Redis
-- forever), but it also means the 101st permanent failure evicts the first one:
-- the payload, the error and the attempt count are gone, and there is nothing left
-- to replay or even to count. "Alerts stopped being delivered three days ago" then
-- has no evidence trail at all.
--
-- WorkerRunner writes one row here for every job that fails on its FINAL attempt
-- (`job.attemptsMade >= job.opts.attempts`). Retryable attempts are not recorded:
-- they are normal operation and would drown the table.
--
-- RETENTION -- READ THIS BEFORE DEPLOYING
-- ---------------------------------------
-- This table has no natural upper bound: a permanently broken feed host or a
-- misconfigured webhook can produce a row on every poll interval, forever. It is
-- pruned by `DeadLetterRepository.purgeOlderThan(DEAD_LETTER_RETENTION_DAYS)`,
-- which the repository runs opportunistically (at most once per hour per process)
-- from the same `record()` call that grows the table -- so the table cannot grow
-- without the pruner also running. The equivalent manual statement is:
--
--     DELETE FROM dead_letter_jobs WHERE failed_at < NOW() - INTERVAL '30 days';
--
-- `idx_dead_letter_jobs_failed_at` exists purely to keep that DELETE off a
-- sequential scan; the composite index below cannot serve it because `queue` is
-- unconstrained there.
--
-- PAYLOAD SIZE: `payload` is capped by the repository before it is written
-- (DEAD_LETTER_MAX_PAYLOAD_BYTES). The OPML parse job carries a whole uploaded
-- document in `opmlXml`, which would otherwise put multi-megabyte rows in here.

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
    id BIGSERIAL PRIMARY KEY,
    queue TEXT NOT NULL,
    job_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    error TEXT,
    attempts INT NOT NULL,
    failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The operator read path: "what died on the alert-delivery queue recently".
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_queue_failed_at
    ON dead_letter_jobs (queue, failed_at DESC);

-- The retention path (see above).
CREATE INDEX IF NOT EXISTS idx_dead_letter_jobs_failed_at
    ON dead_letter_jobs (failed_at);
