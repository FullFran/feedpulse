-- 0015_feed_claim_sweep.sql
--
-- Adds a `claimed_at` marker on feeds so the scheduler can distinguish feeds
-- currently being processed from feeds available to claim. Without it a worker
-- crash between "claim" and "fetch" strands the feed for a whole poll interval,
-- because `claimDueFeeds` has already pushed `next_check_at` into the future.
--
-- Lifecycle:
--   * claimDueFeeds       -> SET claimed_at = NOW() inside the same atomic UPDATE
--                            that pushes next_check_at into the future.
--   * updateAfterFetch    -> SET claimed_at = NULL on the success and the failure path.
--   * ReleaseStuckFeeds   -> sweep rows whose claimed_at is older than
--                            SCHEDULER_STUCK_FEED_THRESHOLD_SECONDS and reset them
--                            (claimed_at = NULL, next_check_at = NOW()).
--
-- Additive and nullable, so it is safe to apply to a live database.

ALTER TABLE feeds
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NULL;

-- Partial index: the sweep only ever scans currently claimed rows, which is a tiny
-- subset of the table (at most SCHEDULER_BATCH_SIZE x active workers).
CREATE INDEX IF NOT EXISTS idx_feeds_claimed_at
    ON feeds (claimed_at)
    WHERE claimed_at IS NOT NULL;
