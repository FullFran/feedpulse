import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

/**
 * Fixed key for the session-level advisory lock that serializes migration runs.
 * Every replica must use the same key, so it is a constant and never derived
 * from configuration.
 */
export const MIGRATIONS_ADVISORY_LOCK_KEY = 728_314_509;

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 500;

export interface MigrationLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ApplyMigrationsOptions {
  /** Advisory lock key. Only override in tests. */
  lockKey?: number;
  /** Maximum time to wait for another process to release the migration lock. */
  lockTimeoutMs?: number;
  /** Delay between advisory lock acquisition attempts. */
  lockRetryDelayMs?: number;
  logger?: MigrationLogger;
}

/** Thrown when another process holds the migration lock for too long. */
export class MigrationLockTimeoutError extends Error {
  readonly code = 'MIGRATION_LOCK_TIMEOUT';

  constructor(
    readonly lockKey: number,
    readonly timeoutMs: number,
  ) {
    super(
      `Timed out after ${timeoutMs}ms waiting for the migration advisory lock (${lockKey}). ` +
        'Another process is still applying migrations, or a previous run died holding the lock. ' +
        "Inspect pg_locks for locktype = 'advisory' before retrying.",
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

/** Thrown when an already applied migration file has been modified on disk. */
export class MigrationChecksumMismatchError extends Error {
  readonly code = 'MIGRATION_CHECKSUM_MISMATCH';

  constructor(
    readonly version: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
    readonly nextFreeVersion: string,
  ) {
    super(
      `Migration "${version}" has already been applied but its content changed ` +
        `(recorded sha256 ${expectedChecksum}, current sha256 ${actualChecksum}). ` +
        'Migrations are append-only: never edit a migration that has already run. ' +
        `Revert "${version}" to its applied content and add your change as "${nextFreeVersion}" instead.`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Hash the migration body. Line endings are normalized so a CRLF checkout does
 * not look like a tampered migration.
 */
export function computeMigrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function nextFreeVersion(files: readonly string[]): string {
  const highest = files.reduce((max, file) => {
    const version = /^(\d+)/.exec(file)?.[1];
    if (version === undefined) {
      return max;
    }
    return Math.max(max, Number.parseInt(version, 10));
  }, 0);

  return `${String(highest + 1).padStart(4, '0')}_<describe_your_change>.sql`;
}

async function acquireAdvisoryLock(
  client: PoolClient,
  lockKey: number,
  timeoutMs: number,
  retryDelayMs: number,
  logger: MigrationLogger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let waiting = false;

  for (;;) {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);

    if (result.rows[0]?.locked) {
      if (waiting) {
        logger.log(`[migrations] acquired advisory lock ${lockKey} after waiting for another process`);
      }
      return;
    }

    if (!waiting) {
      waiting = true;
      logger.warn(
        `[migrations] advisory lock ${lockKey} is held by another process; waiting up to ${timeoutMs}ms before giving up`,
      );
    }

    if (Date.now() >= deadline) {
      throw new MigrationLockTimeoutError(lockKey, timeoutMs);
    }

    await delay(retryDelayMs);
  }
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Apply a single migration inside its own transaction.
 *
 * The "has this already run?" decision is made by the INSERT itself, so the
 * runner stays correct even if the advisory lock is bypassed: the loser of a
 * concurrent race gets zero rows back and skips the DDL entirely instead of
 * executing it and failing on the primary key afterwards.
 *
 * @returns true when this call applied the migration.
 */
async function applyMigration(
  client: PoolClient,
  file: string,
  sql: string,
  checksum: string,
  files: readonly string[],
): Promise<boolean> {
  await client.query('BEGIN');

  try {
    const claim = await client.query<{ version: string }>(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING RETURNING version',
      [file, checksum],
    );

    if (!claim.rowCount) {
      const recorded = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [file],
      );
      const storedChecksum = recorded.rows[0]?.checksum ?? null;

      if (storedChecksum === null) {
        // Row created before checksums existed: backfill instead of failing.
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1 AND checksum IS NULL', [
          file,
          checksum,
        ]);
      } else if (storedChecksum !== checksum) {
        throw new MigrationChecksumMismatchError(file, storedChecksum, checksum, nextFreeVersion(files));
      }

      await client.query('COMMIT');
      return false;
    }

    await client.query(sql);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Apply every pending migration in `migrationsDir`, in filename order.
 *
 * The whole run is serialized by a session-level `pg_advisory_lock` taken on a
 * dedicated connection, so concurrent deploys (docker-compose runs `migrate` in
 * the api service command) cannot both execute the same DDL.
 *
 * @returns the versions applied by this call.
 */
export async function applyMigrations(
  pool: Pool,
  migrationsDir = join(process.cwd(), 'db', 'migrations'),
  options: ApplyMigrationsOptions = {},
): Promise<string[]> {
  const lockKey = options.lockKey ?? MIGRATIONS_ADVISORY_LOCK_KEY;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockRetryDelayMs = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const logger = options.logger ?? console;

  // The lock must live on one dedicated connection for its whole lifetime.
  // Taking it through pool.query() would land it on an arbitrary connection and
  // the unlock could target a different one.
  const lockClient = await pool.connect();
  let locked = false;

  try {
    await acquireAdvisoryLock(lockClient, lockKey, lockTimeoutMs, lockRetryDelayMs, logger);
    locked = true;

    await ensureMigrationsTable(pool);

    const files = await listMigrationFiles(migrationsDir);
    const applied: string[] = [];

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = computeMigrationChecksum(sql);

      const client = await pool.connect();
      try {
        if (await applyMigration(client, file, sql, checksum, files)) {
          applied.push(file);
          logger.log(`[migrations] applied ${file}`);
        }
      } finally {
        client.release();
      }
    }

    return applied;
  } finally {
    try {
      if (locked) {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      }
    } finally {
      lockClient.release();
    }
  }
}
