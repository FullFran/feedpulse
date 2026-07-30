import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { applyMigrations, computeMigrationChecksum } from '../src/infrastructure/persistence/migrations';

/**
 * Migration fidelity: every file under `db/migrations` has to apply, in order,
 * from a genuinely empty database, and the schema it leaves behind has to be the
 * one the repositories are written against.
 *
 * This cannot be emulated. The migration set uses `translate()`, `normalize()`,
 * PL/pgSQL bodies, `DO $$ ... $$` loops, `ROW_NUMBER() OVER`, `FIRST_VALUE()
 * OVER`, `UPDATE ... FROM`, `DELETE ... USING <temp table>`, `CREATE TEMP TABLE
 * ... ON COMMIT DROP` and a `STORED GENERATED` column. An in-memory Postgres
 * fake implements none of that, so the only useful assertion is against a real
 * server.
 *
 * Point `TEST_DATABASE_URL` (or `DATABASE_URL`) at any reachable Postgres 13+
 * instance to run this suite; it skips otherwise so contributors without Docker
 * still get a green `npm test`.
 *
 * The suite never touches the database named in the connection string: it uses
 * it only to `CREATE DATABASE` a throwaway, migrates that, and drops it again.
 * Migrations 0016-0018 use `CREATE OR REPLACE FUNCTION` / `DROP FUNCTION` and
 * delete rows, so replaying them over shared state is how you get failures that
 * belong to the previous run.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

/** Identifier-safe, unique per process, and short enough for Postgres' 63-byte limit. */
const SCRATCH_DATABASE = `feedpulse_migrations_${process.pid}_${Date.now().toString(36)}`;

/** `applyMigrations` logs one line per file; keep the suite output readable. */
const silentLogger = {
  log: (): void => undefined,
  warn: (): void => undefined,
};

function scratchConnectionString(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function listMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
}

describeWithDatabase('db/migrations against a real Postgres', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let migrationFiles: string[] = [];
  let firstRun: string[] = [];
  let secondRun: string[] = [];

  beforeAll(async () => {
    migrationFiles = await listMigrationFiles();

    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    // CREATE DATABASE cannot run inside a transaction block, so it goes through
    // the pool directly rather than through any helper that opens one.
    await adminPool.query(`CREATE DATABASE "${SCRATCH_DATABASE}"`);

    pool = new Pool({ connectionString: scratchConnectionString(databaseUrl, SCRATCH_DATABASE) });

    // `DROP DATABASE ... WITH (FORCE)` in afterAll calls pg_terminate_backend on
    // every backend still attached to the scratch database. `pool.end()` runs
    // first, but it resolves once the clients are released — the sockets can
    // still be closing — so a terminated backend occasionally reaches this pool
    // as an idle-client 'error' event. With no listener, Node treats that as an
    // unhandled error and Jest fails the whole suite *after* all 9 tests have
    // passed. 57P01 (admin_shutdown) is the expected code for a termination we
    // asked for; anything else is a real fault and must still be fatal.
    pool.on('error', (error: Error & { code?: string }) => {
      if (error.code !== '57P01') {
        throw error;
      }
    });

    firstRun = await applyMigrations(pool, MIGRATIONS_DIR, { logger: silentLogger });
    secondRun = await applyMigrations(pool, MIGRATIONS_DIR, { logger: silentLogger });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();

    if (adminPool) {
      try {
        // FORCE (Postgres 13+) terminates leftover backends; without it a single
        // stray connection leaves the throwaway database behind forever.
        await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}" WITH (FORCE)`);
      } catch {
        await adminPool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DATABASE}"`);
      }
      await adminPool.end();
    }
  }, 60_000);

  function requirePool(): Pool {
    if (!pool) {
      throw new Error('The scratch database pool was not initialized');
    }
    return pool;
  }

  async function publicIndexNames(): Promise<string[]> {
    const result = await requirePool().query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
    );
    return result.rows.map((row) => row.indexname);
  }

  async function constraintNames(table: string): Promise<string[]> {
    const result = await requirePool().query<{ conname: string }>(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relname = $1
        ORDER BY c.conname`,
      [table],
    );
    return result.rows.map((row) => row.conname);
  }

  async function functionExists(name: string): Promise<boolean> {
    const result = await requirePool().query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1
       ) AS exists`,
      [name],
    );
    return result.rows[0]?.exists === true;
  }

  it('applies every migration file exactly once, in lexical order, from an empty database', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(firstRun).toEqual(migrationFiles);

    // The runner orders by filename, so the numeric prefixes have to be unique
    // and ascending or "lexical order" and "chronological order" drift apart.
    const versions = migrationFiles.map((file) => Number.parseInt(file.slice(0, 4), 10));
    expect(versions.every((version) => Number.isInteger(version))).toBe(true);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });

  it('records one schema_migrations row per file, with its sha256 checksum', async () => {
    const recorded = await requirePool().query<{ version: string; checksum: string | null }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );

    expect(recorded.rows.map((row) => row.version)).toEqual(migrationFiles);
    expect(recorded.rowCount).toBe(migrationFiles.length);

    const expectedChecksums = await Promise.all(
      migrationFiles.map(async (file) => computeMigrationChecksum(await readFile(join(MIGRATIONS_DIR, file), 'utf8'))),
    );
    expect(recorded.rows.map((row) => row.checksum)).toEqual(expectedChecksums);
  });

  it('is idempotent: a second run over the migrated database applies nothing', () => {
    expect(secondRun).toEqual([]);
  });

  it('converges on one total uniqueness rule for alerts', async () => {
    const indexes = await publicIndexNames();

    // 0018 is the current model: one alert per (tenant, article), where an entry
    // without a usable link degrades to per-entry dedupe instead of no dedupe.
    expect(indexes).toContain('idx_alerts_tenant_dedupe_key_unique');

    // Both partial predecessors must be gone, otherwise the ON CONFLICT in
    // AlertsRepository.createForEntryWithRules can infer the wrong index.
    expect(indexes).not.toContain('idx_alerts_tenant_canonical_link_unique');
    expect(indexes).not.toContain('idx_alerts_tenant_rule_canonical_link_unique');

    const definition = await requirePool().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_alerts_tenant_dedupe_key_unique'",
    );
    expect(definition.rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(definition.rows[0]?.indexdef).toContain('tenant_id');
    expect(definition.rows[0]?.indexdef).toContain("'entry:'");
  });

  it('drops the legacy one-alert-per-rule constraint on alerts', async () => {
    expect(await constraintNames('alerts')).not.toContain('alerts_entry_id_rule_id_key');
  });

  it('exposes feeds.claimed_at so stuck claims can be swept', async () => {
    const column = await requirePool().query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'feeds' AND column_name = 'claimed_at'`,
    );

    expect(column.rowCount).toBe(1);
    expect(column.rows[0]?.data_type).toBe('timestamp with time zone');
    expect(column.rows[0]?.is_nullable).toBe('YES');
    expect(await publicIndexNames()).toContain('idx_feeds_claimed_at');
  });

  it('creates api_keys and refuses a duplicate key_hash', async () => {
    const columns = await requirePool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'api_keys'
        ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'created_at',
      'id',
      'key_hash',
      'label',
      'last_used_at',
      'prefix',
      'revoked_at',
      'tenant_id',
    ]);

    await requirePool().query(
      "INSERT INTO api_keys (tenant_id, key_hash, prefix) VALUES ('tenant_a', 'hash_dup', 'fp_aaaa')",
    );
    await expect(
      requirePool().query(
        "INSERT INTO api_keys (tenant_id, key_hash, prefix) VALUES ('tenant_b', 'hash_dup', 'fp_bbbb')",
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Revocation-aware lookups run on their own partial index.
    expect(await publicIndexNames()).toContain('idx_api_keys_active_key_hash');
  });

  it('keeps the shared search normalizer and drops the one-shot canonicalizer', async () => {
    // 0016 installs a function the generated column depends on: it must survive.
    expect(await functionExists('feedpulse_normalize_search_text')).toBe(true);
    // 0018 only needs its canonicalizer for the backfill and drops it at the end.
    expect(await functionExists('feedpulse_canonicalize_article_link')).toBe(false);
  });

  it('stores entries.normalized_search_document as a generated column', async () => {
    const column = await requirePool().query<{ is_generated: string; generation_expression: string | null }>(
      `SELECT is_generated, generation_expression
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'entries'
          AND column_name = 'normalized_search_document'`,
    );

    expect(column.rowCount).toBe(1);
    expect(column.rows[0]?.is_generated).toBe('ALWAYS');
    expect(column.rows[0]?.generation_expression).toContain('feedpulse_normalize_search_text');
  });
});
