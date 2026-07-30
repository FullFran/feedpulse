import { Pool } from 'pg';
import { expectDefined } from './support/expect-defined';
import {
  createPgMemPoolWithSchema,
  declaredPgMemIndexNames,
  KNOWN_SCHEMA_DIVERGENCES,
  PG_MEM_OMITTED_INDEXES,
  resetSchemaWithMigrations,
} from './support/schema';

/**
 * The anti-drift spec.
 *
 * `test/support/schema.ts` is a hand-written transcription of what
 * `db/migrations/0001..NNNN.sql` produce. A transcription rots: before this
 * suite existed, four separate copies of it had each rotted in a different
 * direction, and repositories were being tested against a schema production had
 * not had for months.
 *
 * This suite applies the real migrations to a real PostgreSQL, builds the
 * emulator schema next to it, and diffs the two. Anything that is genuinely
 * impossible under pg-mem has to be declared in `KNOWN_SCHEMA_DIVERGENCES` or
 * `PG_MEM_OMITTED_INDEXES`; everything else fails here.
 *
 * Point `TEST_DATABASE_URL` at a throwaway database to run it; it skips
 * otherwise. It owns the `schema_parity` schema, which it DROPs and recreates,
 * so it can share a database with the other integration suites.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const TEST_SCHEMA = 'schema_parity';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

/**
 * Folds the two engines' type vocabularies onto one canonical name.
 *
 * `bigint -> integer` is the one lossy step and it is forced: pg-mem does not
 * expose a 64-bit integer type through `information_schema`. Everything else is
 * a pure spelling difference.
 */
const CANONICAL_TYPES: Readonly<Record<string, string>> = {
  'timestamp with time zone': 'timestamptz',
  timestamptz: 'timestamptz',
  text: 'text',
  'character varying': 'text',
  boolean: 'boolean',
  bool: 'boolean',
  'double precision': 'float',
  float: 'float',
  ARRAY: 'array',
  array: 'array',
  integer: 'integer',
  bigint: 'integer',
};

function canonicalType(dataType: string): string {
  return CANONICAL_TYPES[dataType] ?? dataType;
}

function toColumnMap(rows: ColumnRow[]): Map<string, string> {
  return new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, canonicalType(row.data_type)]));
}

describeWithDatabase('pg-mem schema parity with db/migrations', () => {
  let pool: Pool;
  let realColumns: Map<string, string>;
  let memColumns: Map<string, string>;
  let realIndexNames: string[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${TEST_SCHEMA}` });
    await resetSchemaWithMigrations(pool, TEST_SCHEMA);

    const realResult = await pool.query<ColumnRow>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1`,
      [TEST_SCHEMA],
    );
    realColumns = toColumnMap(realResult.rows);

    const indexResult = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE 'idx\\_%' ORDER BY indexname`,
      [TEST_SCHEMA],
    );
    realIndexNames = indexResult.rows.map((row) => row.indexname);

    const { pool: memPool } = await createPgMemPoolWithSchema();
    const memResult = await memPool.query<ColumnRow>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    memColumns = toColumnMap(memResult.rows);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('declares the same tables as the migrations', () => {
    const tablesOf = (columns: Map<string, string>): string[] =>
      [...new Set([...columns.keys()].map((key) => expectDefined(key.split('.')[0])))].sort();

    expect(tablesOf(memColumns)).toEqual(tablesOf(realColumns));
  });

  it('declares no column the migrations do not create', () => {
    const extra = [...memColumns.keys()].filter((key) => !realColumns.has(key)).sort();

    expect(extra).toEqual([]);
  });

  it('declares every column the migrations create', () => {
    const missing = [...realColumns.keys()].filter((key) => !memColumns.has(key)).sort();

    expect(missing).toEqual([]);
  });

  it('gives every shared column the same canonical type', () => {
    const mismatches = [...realColumns.entries()]
      .filter(([key, realType]) => memColumns.has(key) && memColumns.get(key) !== realType)
      .map(([key, realType]) => `${key}: migrations=${realType} pg-mem=${memColumns.get(key)}`)
      .sort();

    expect(mismatches).toEqual([]);
  });

  it('declares every named index the migrations create, minus the documented omissions', () => {
    const expected = realIndexNames.filter((name) => !PG_MEM_OMITTED_INDEXES.includes(name)).sort();

    expect(declaredPgMemIndexNames()).toEqual(expected);
  });

  it('keeps the alert dedupe rules that migrations 0013 and 0018 landed', () => {
    // These three are the concrete drifts the per-suite schemas carried: the
    // 0001 unique constraint that 0013 drops, the 0012 index that 0018 drops,
    // and the total expression index 0018 replaces them with.
    expect(realIndexNames).toContain('idx_alerts_tenant_dedupe_key_unique');
    expect(realIndexNames).not.toContain('idx_alerts_tenant_rule_canonical_link_unique');
    expect(realIndexNames).not.toContain('idx_alerts_tenant_canonical_link_unique');

    const constraints = declaredPgMemIndexNames();
    expect(constraints).toContain('idx_alerts_tenant_dedupe_key_unique');
    expect(constraints).not.toContain('idx_alerts_tenant_rule_canonical_link_unique');
  });

  it('documents a reason for every declared divergence', () => {
    for (const divergence of KNOWN_SCHEMA_DIVERGENCES) {
      expect(divergence.what.length).toBeGreaterThan(0);
      expect(divergence.why.length).toBeGreaterThan(0);
    }
  });
});
