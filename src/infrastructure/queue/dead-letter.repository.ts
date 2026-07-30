import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../persistence/database.service';
import {
  ALERT_DELIVERY_QUEUE_NAME,
  FETCH_FEED_QUEUE_NAME,
  OPML_APPLY_IMPORT_QUEUE_NAME,
  OPML_PARSE_PREVIEW_QUEUE_NAME,
} from './queue.constants';

/**
 * The four queue names this deployment runs. It is a CLOSED set on purpose: it is
 * the only value ever used as a Prometheus `queue` label, and an open set there
 * (a feed id, a tenant id, a job id) turns one time series into millions.
 */
export const KNOWN_QUEUE_NAMES = [
  FETCH_FEED_QUEUE_NAME,
  ALERT_DELIVERY_QUEUE_NAME,
  OPML_PARSE_PREVIEW_QUEUE_NAME,
  OPML_APPLY_IMPORT_QUEUE_NAME,
] as const;

export type KnownQueueName = (typeof KNOWN_QUEUE_NAMES)[number];

export function isKnownQueueName(value: string): value is KnownQueueName {
  return (KNOWN_QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * Serialized payloads larger than this are replaced by a truncation marker.
 *
 * The OPML parse job carries an entire uploaded document in `opmlXml`
 * (OPML_UPLOAD_MAX_BYTES, megabytes by default). Writing that verbatim on every
 * permanent failure would make this table the largest one in the database and
 * would push a multi-megabyte string through the `pg` protocol from inside a
 * BullMQ event handler.
 */
export const DEAD_LETTER_MAX_PAYLOAD_BYTES = 8_192;

/** Postgres TEXT is unbounded; the error message is not worth an unbounded column value. */
export const DEAD_LETTER_MAX_ERROR_CHARS = 2_000;

/** Documented default retention. See the header of 0019_dead_letter_jobs.sql. */
export const DEAD_LETTER_RETENTION_DAYS = 30;

/**
 * Minimum wall-clock gap between two opportunistic purges in the same process.
 * Dead letters are rare, so one indexed DELETE per hour is free; the throttle is
 * there so a burst of a thousand terminal failures does not run a thousand DELETEs.
 */
export const DEAD_LETTER_PURGE_INTERVAL_MS = 3_600_000;

export interface DeadLetterEntry {
  readonly queue: KnownQueueName;
  readonly jobId: string;
  readonly payload: unknown;
  readonly error: string | null;
  readonly attempts: number;
}

export interface DeadLetterJobView {
  readonly id: string;
  readonly queue: string;
  readonly jobId: string;
  readonly payload: unknown;
  readonly error: string | null;
  readonly attempts: number;
  readonly failedAt: string;
}

interface DeadLetterRow {
  id: string;
  queue: string;
  job_id: string;
  payload: unknown;
  error: string | null;
  attempts: number;
  failed_at: Date;
}

/**
 * Caps the serialized size of a job payload.
 *
 * Returns a marker object rather than a truncated JSON string, because half a JSON
 * document is not JSON and the column is JSONB. The marker keeps the byte count so
 * an operator can tell "this was dropped for size" from "this job had no payload".
 */
export function capDeadLetterPayload(payload: unknown, maxBytes: number = DEAD_LETTER_MAX_PAYLOAD_BYTES): unknown {
  let serialized: string;

  try {
    serialized = JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    // Circular structures and BigInt both throw here. A job payload should never
    // contain either, but an event handler is the wrong place to find that out.
    return { truncated: true, reason: 'not_serializable' };
  }

  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength <= maxBytes) {
    return payload ?? null;
  }

  return {
    truncated: true,
    reason: 'payload_too_large',
    byteLength,
    maxBytes,
    preview: serialized.slice(0, 512),
  };
}

/** Trims an error message to a bounded length, preserving the informative head. */
export function capDeadLetterError(
  error: string | null,
  maxChars: number = DEAD_LETTER_MAX_ERROR_CHARS,
): string | null {
  if (error === null) {
    return null;
  }

  return error.length <= maxChars ? error : `${error.slice(0, maxChars)}… [truncated]`;
}

/**
 * Persistent store for jobs that exhausted every retry.
 *
 * BullMQ's `removeOnFail: 100` bounds Redis, not history: the 101st permanent
 * failure evicts the first. This table is the durable side of that, so a
 * permanently failed job stays inspectable and replayable instead of vanishing.
 */
@Injectable()
export class DeadLetterRepository {
  private readonly logger = new Logger(DeadLetterRepository.name);

  /** Epoch millis of the last opportunistic purge; 0 means "never in this process". */
  private lastPurgeAtMs = 0;

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Records one terminally failed job.
   *
   * Rejects on database failure. Callers that run inside a BullMQ event handler
   * must catch: an unhandled rejection there takes the worker process down, which
   * would turn "one job died" into "the whole worker died".
   */
  async record(entry: DeadLetterEntry): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO dead_letter_jobs (queue, job_id, payload, error, attempts)
        VALUES ($1, $2, $3::jsonb, $4, $5)
      `,
      [
        entry.queue,
        entry.jobId,
        JSON.stringify(capDeadLetterPayload(entry.payload)),
        capDeadLetterError(entry.error),
        entry.attempts,
      ],
    );

    await this.purgeIfDue();
  }

  /**
   * Most recent dead letters, newest first. Pass `null` for `queue` to read across
   * every queue. Served by `idx_dead_letter_jobs_queue_failed_at`.
   */
  async listRecent(queue: string | null, limit: number): Promise<DeadLetterJobView[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, 200));

    const result =
      queue === null
        ? await this.databaseService.query<DeadLetterRow>(
            `SELECT id, queue, job_id, payload, error, attempts, failed_at
             FROM dead_letter_jobs
             ORDER BY failed_at DESC, id DESC
             LIMIT $1`,
            [boundedLimit],
          )
        : await this.databaseService.query<DeadLetterRow>(
            `SELECT id, queue, job_id, payload, error, attempts, failed_at
             FROM dead_letter_jobs
             WHERE queue = $1
             ORDER BY failed_at DESC, id DESC
             LIMIT $2`,
            [queue, boundedLimit],
          );

    return result.rows.map((row) => ({
      id: String(row.id),
      queue: row.queue,
      jobId: row.job_id,
      payload: row.payload,
      error: row.error,
      attempts: Number(row.attempts),
      failedAt: new Date(row.failed_at).toISOString(),
    }));
  }

  /** Deletes rows older than `days`. Returns how many were removed. */
  async purgeOlderThan(days: number = DEAD_LETTER_RETENTION_DAYS): Promise<number> {
    const safeDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEAD_LETTER_RETENTION_DAYS;

    // The interval is built from a validated integer rather than bound as a
    // parameter because PostgreSQL cannot parameterize an INTERVAL literal.
    const result = await this.databaseService.query(
      `DELETE FROM dead_letter_jobs WHERE failed_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    );

    return result.rowCount ?? 0;
  }

  /**
   * Runs retention at most once per DEAD_LETTER_PURGE_INTERVAL_MS.
   *
   * Deliberately coupled to `record()`: the table only ever grows through that
   * call, so pruning there guarantees the bound holds without depending on any
   * scheduler being deployed. A purge failure is logged, never propagated -- the
   * dead letter itself is already safely written by this point.
   */
  private async purgeIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPurgeAtMs < DEAD_LETTER_PURGE_INTERVAL_MS) {
      return;
    }

    // Claim the slot before awaiting, so concurrent terminal failures do not all
    // see a stale timestamp and fire the DELETE together.
    this.lastPurgeAtMs = now;

    try {
      const removed = await this.purgeOlderThan();
      if (removed > 0) {
        this.logger.log(`Purged ${removed} dead letter job(s) older than ${DEAD_LETTER_RETENTION_DAYS} days`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown dead letter purge failure';
      this.logger.warn(`Dead letter retention purge failed: ${message}`);
    }
  }
}
