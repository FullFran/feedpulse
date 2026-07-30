import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  MigrationChecksumMismatchError,
  MigrationLockTimeoutError,
  applyMigrations,
  computeMigrationChecksum,
} from '../src/infrastructure/persistence/migrations';
import { expectDefined } from './support/expect-defined';

interface MigrationRow {
  version: string;
  checksum: string | null;
  applied_at: Date;
}

interface LockEvent {
  clientId: number;
  type: 'acquire' | 'release';
}

/**
 * In-memory stand-in for Postgres that models exactly the statements the
 * migration runner issues, plus the two behaviours the runner depends on:
 * transaction rollback and session-level advisory locks.
 *
 * pg-mem cannot be used here: its pg adapter ignores ROLLBACK and returns a row
 * from `INSERT ... ON CONFLICT DO NOTHING RETURNING`, which are the two
 * semantics under test.
 */
class FakeDatabase {
  rows: MigrationRow[] = [];
  tableExists = false;
  readonly locks = new Set<number>();
  readonly lockEvents: LockEvent[] = [];
  readonly executed: string[] = [];
  readonly failingBodies = new Set<string>();
  openClients = 0;
  totalClients = 0;
  lockContentionCount = 0;
  activeBodies = 0;
  maxConcurrentBodies = 0;

  findRow(version: string): MigrationRow | undefined {
    return this.rows.find((row) => row.version === version);
  }
}

class FakeClient {
  private snapshot: MigrationRow[] | null = null;
  private pendingBodies: string[] = [];
  private released = false;

  constructor(
    private readonly db: FakeDatabase,
    readonly id: number,
  ) {}

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    if (this.released) {
      throw new Error('Client already released');
    }

    const sql = text.trim();

    if (/pg_try_advisory_lock/i.test(sql)) {
      const key = values[0] as number;
      if (this.db.locks.has(key)) {
        this.db.lockContentionCount += 1;
        return { rows: [{ locked: false }], rowCount: 1 };
      }
      this.db.locks.add(key);
      this.db.lockEvents.push({ clientId: this.id, type: 'acquire' });
      return { rows: [{ locked: true }], rowCount: 1 };
    }

    if (/pg_advisory_unlock/i.test(sql)) {
      const key = values[0] as number;
      const held = this.db.locks.delete(key);
      this.db.lockEvents.push({ clientId: this.id, type: 'release' });
      return { rows: [{ pg_advisory_unlock: held }], rowCount: 1 };
    }

    if (sql === 'BEGIN') {
      this.snapshot = this.db.rows.map((row) => ({ ...row }));
      this.pendingBodies = [];
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'COMMIT') {
      this.db.executed.push(...this.pendingBodies);
      this.pendingBodies = [];
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.db.rows = this.snapshot;
      }
      this.pendingBodies = [];
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
      this.db.tableExists = true;
      return { rows: [], rowCount: 0 };
    }

    if (/^ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum/i.test(sql)) {
      this.assertTableExists();
      return { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO schema_migrations/i.test(sql)) {
      this.assertTableExists();
      const [version, checksum] = values as [string, string];
      if (this.db.findRow(version)) {
        return { rows: [], rowCount: 0 };
      }
      this.db.rows.push({ version, checksum, applied_at: new Date(0) });
      return { rows: [{ version }], rowCount: 1 };
    }

    if (/^SELECT checksum FROM schema_migrations/i.test(sql)) {
      this.assertTableExists();
      const row = this.db.findRow(values[0] as string);
      return row ? { rows: [{ checksum: row.checksum }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (/^UPDATE schema_migrations SET checksum/i.test(sql)) {
      this.assertTableExists();
      const [version, checksum] = values as [string, string];
      const row = this.db.findRow(version);
      if (row && row.checksum === null) {
        row.checksum = checksum;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    return this.executeMigrationBody(sql);
  }

  release(): void {
    this.released = true;
    this.db.openClients -= 1;
  }

  private assertTableExists(): void {
    if (!this.db.tableExists) {
      throw new Error('relation "schema_migrations" does not exist');
    }
  }

  private async executeMigrationBody(sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.db.activeBodies += 1;
    this.db.maxConcurrentBodies = Math.max(this.db.maxConcurrentBodies, this.db.activeBodies);

    try {
      // Yield the event loop so interleaved runs would be observable.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      if (this.db.failingBodies.has(sql)) {
        throw new Error('syntax error at or near "BOOM"');
      }

      this.pendingBodies.push(sql);
      return { rows: [], rowCount: 0 };
    } finally {
      this.db.activeBodies -= 1;
    }
  }
}

class FakePool {
  constructor(private readonly db: FakeDatabase) {}

  async connect(): Promise<FakeClient> {
    this.db.openClients += 1;
    this.db.totalClients += 1;
    return new FakeClient(this.db, this.db.totalClients);
  }

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }
}

const silentLogger = { log: () => undefined, warn: () => undefined };

function fakePool(db: FakeDatabase): Pool {
  return new FakePool(db) as unknown as Pool;
}

const fastOptions = { lockRetryDelayMs: 0, logger: silentLogger };

describe('applyMigrations', () => {
  let migrationsDir: string;
  let db: FakeDatabase;

  const firstBody = 'CREATE TABLE first_table (id INT);';
  const secondBody = 'CREATE TABLE second_table (id INT);';

  beforeEach(async () => {
    migrationsDir = await mkdtemp(join(tmpdir(), 'feedpulse-migrations-'));
    await writeFile(join(migrationsDir, '0001_first.sql'), firstBody, 'utf8');
    await writeFile(join(migrationsDir, '0002_second.sql'), secondBody, 'utf8');
    db = new FakeDatabase();
  });

  afterEach(async () => {
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it('applies pending migrations in filename order', async () => {
    const applied = await applyMigrations(fakePool(db), migrationsDir, fastOptions);

    expect(applied).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(db.executed).toEqual([firstBody, secondBody]);
    expect(db.rows.map((row) => row.version)).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await applyMigrations(fakePool(db), migrationsDir, fastOptions);
    const applied = await applyMigrations(fakePool(db), migrationsDir, fastOptions);

    expect(applied).toEqual([]);
    expect(db.executed).toEqual([firstBody, secondBody]);
  });

  it('records the sha256 checksum of every applied migration', async () => {
    await applyMigrations(fakePool(db), migrationsDir, fastOptions);

    expect(db.findRow('0001_first.sql')?.checksum).toBe(computeMigrationChecksum(firstBody));
    expect(db.findRow('0002_second.sql')?.checksum).toBe(computeMigrationChecksum(secondBody));
  });

  it('ignores CRLF-only differences when checksumming', () => {
    expect(computeMigrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')).toBe(
      computeMigrationChecksum('SELECT 1;\nSELECT 2;\n'),
    );
  });

  it('rolls back a broken migration and leaves schema_migrations untouched', async () => {
    const brokenBody = 'BOOM;';
    await writeFile(join(migrationsDir, '0003_broken.sql'), brokenBody, 'utf8');
    db.failingBodies.add(brokenBody);

    await expect(applyMigrations(fakePool(db), migrationsDir, fastOptions)).rejects.toThrow(/syntax error/);

    expect(db.rows.map((row) => row.version)).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(db.executed).toEqual([firstBody, secondBody]);
    expect(db.findRow('0003_broken.sql')).toBeUndefined();
  });

  it('releases the advisory lock and every client when a migration fails', async () => {
    const brokenBody = 'BOOM;';
    await writeFile(join(migrationsDir, '0003_broken.sql'), brokenBody, 'utf8');
    db.failingBodies.add(brokenBody);

    await expect(applyMigrations(fakePool(db), migrationsDir, fastOptions)).rejects.toThrow(/syntax error/);

    expect(db.locks.size).toBe(0);
    expect(db.openClients).toBe(0);
  });

  it('fails loudly when an already applied migration was edited', async () => {
    await applyMigrations(fakePool(db), migrationsDir, fastOptions);
    await writeFile(
      join(migrationsDir, '0001_first.sql'),
      `${firstBody}\nALTER TABLE first_table ADD COLUMN name TEXT;`,
      'utf8',
    );

    const run = applyMigrations(fakePool(db), migrationsDir, fastOptions);

    await expect(run).rejects.toBeInstanceOf(MigrationChecksumMismatchError);
    await expect(run).rejects.toThrow(/append-only/);
    await expect(run).rejects.toThrow(/0003_/);
    expect(db.executed).toEqual([firstBody, secondBody]);
  });

  it('backfills the checksum of rows applied before checksums existed', async () => {
    db.tableExists = true;
    db.rows.push({ version: '0001_first.sql', checksum: null, applied_at: new Date(0) });

    const applied = await applyMigrations(fakePool(db), migrationsDir, fastOptions);

    expect(applied).toEqual(['0002_second.sql']);
    expect(db.findRow('0001_first.sql')?.checksum).toBe(computeMigrationChecksum(firstBody));
    expect(db.executed).toEqual([secondBody]);
  });

  it('takes and releases the advisory lock on a single dedicated client', async () => {
    await applyMigrations(fakePool(db), migrationsDir, fastOptions);

    expect(db.lockEvents).toHaveLength(2);
    expect(db.lockEvents[0]).toEqual({ clientId: 1, type: 'acquire' });
    expect(db.lockEvents[1]).toEqual({ clientId: 1, type: 'release' });
    expect(db.locks.size).toBe(0);
    expect(db.openClients).toBe(0);
  });

  it('serializes concurrent runs so each version is applied exactly once', async () => {
    const pool = fakePool(db);

    const [firstRun, secondRun] = await Promise.all([
      applyMigrations(pool, migrationsDir, fastOptions),
      applyMigrations(pool, migrationsDir, fastOptions),
    ]);

    expect(db.maxConcurrentBodies).toBe(1);
    expect(db.lockContentionCount).toBeGreaterThan(0);
    expect(db.executed).toEqual([firstBody, secondBody]);
    expect([...firstRun, ...secondRun].sort()).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('gives up with a diagnosable error when the lock is held for too long', async () => {
    const holder = await fakePool(db).connect();
    await holder.query('SELECT pg_try_advisory_lock($1) AS locked', [4242]);

    const run = applyMigrations(fakePool(db), migrationsDir, {
      ...fastOptions,
      lockKey: 4242,
      lockTimeoutMs: 0,
    });

    await expect(run).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    await expect(run).rejects.toThrow(/pg_locks/);
    expect(db.executed).toEqual([]);
    expect(db.locks.has(4242)).toBe(true);
  });

  it('does not leak the dedicated client when the lock cannot be acquired', async () => {
    const holder = await fakePool(db).connect();
    await holder.query('SELECT pg_try_advisory_lock($1) AS locked', [4242]);
    const openBefore = db.openClients;

    await expect(
      applyMigrations(fakePool(db), migrationsDir, { ...fastOptions, lockKey: 4242, lockTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    expect(db.openClients).toBe(openBefore);
  });
});

// Real-Postgres coverage for the advisory lock itself. Enabled by the CI
// workflow through TEST_DATABASE_URL; skipped locally when unset.
const testDatabaseUrl = process.env['TEST_DATABASE_URL'];
const describeWithPostgres = testDatabaseUrl ? describe : describe.skip;

describeWithPostgres('applyMigrations against a real Postgres', () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const versions = [`9001_concurrent_${suffix}.sql`, `9002_concurrent_${suffix}.sql`];
  const tables = [`mig_test_a_${suffix}`, `mig_test_b_${suffix}`];

  let migrationsDir: string;
  let pools: Pool[] = [];

  beforeAll(async () => {
    migrationsDir = await mkdtemp(join(tmpdir(), 'feedpulse-migrations-pg-'));
    await writeFile(join(migrationsDir, expectDefined(versions[0])), `CREATE TABLE ${tables[0]} (id INT);`, 'utf8');
    await writeFile(join(migrationsDir, expectDefined(versions[1])), `CREATE TABLE ${tables[1]} (id INT);`, 'utf8');
  });

  afterAll(async () => {
    const cleanupPool = new Pool({ connectionString: testDatabaseUrl });
    try {
      for (const table of tables) {
        await cleanupPool.query(`DROP TABLE IF EXISTS ${table}`);
      }
      await cleanupPool.query('DELETE FROM schema_migrations WHERE version = ANY($1)', [versions]);
    } finally {
      await cleanupPool.end();
    }
    await Promise.all(pools.map((pool) => pool.end()));
    pools = [];
    await rm(migrationsDir, { recursive: true, force: true });
  });

  it('applies each version exactly once across two concurrent invocations', async () => {
    const poolA = new Pool({ connectionString: testDatabaseUrl });
    const poolB = new Pool({ connectionString: testDatabaseUrl });
    pools = [poolA, poolB];

    const options = { lockRetryDelayMs: 20, lockTimeoutMs: 20_000, logger: silentLogger };
    const [appliedA, appliedB] = await Promise.all([
      applyMigrations(poolA, migrationsDir, options),
      applyMigrations(poolB, migrationsDir, options),
    ]);

    expect([...appliedA, ...appliedB].sort()).toEqual([...versions].sort());
    expect(appliedA.filter((version) => appliedB.includes(version))).toEqual([]);

    const applied = await poolA.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = ANY($1) ORDER BY version',
      [versions],
    );
    expect(applied.rows.map((row) => row.version)).toEqual([...versions].sort());
  }, 30_000);
});
