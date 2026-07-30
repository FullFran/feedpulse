import { randomUUID } from 'node:crypto';
import type { IMemoryDb } from 'pg-mem';
import { DataType, newDb } from 'pg-mem';
import { normalizeSearchText } from '../../src/shared/text/normalize-search-text';

/**
 * Shared `pg-mem` engine for the suites that can run against an emulator.
 *
 * Every pg-mem suite used to call `newDb({ autoCreateForeignKeyIndices: true })`
 * and `db.adapters.createPg()` itself, which meant each of them silently ran on
 * slightly different engine options and none of them had the function shims the
 * schema needs. This module is the only place allowed to instantiate pg-mem.
 *
 * WHAT PG-MEM CANNOT DO (and therefore what must NOT be tested here):
 *  - `unnest`, the `xmax` system column, and `ON CONFLICT` targets inferred from
 *    an expression index. `AlertsRepository.createForEntryWithRules` uses all
 *    three, so its suites run against a real PostgreSQL instead.
 *  - Full-text search. `to_tsvector` is shimmed to the identity function purely
 *    so the GIN index DDL parses; it indexes nothing.
 *  - Reliable `is_nullable` reporting in `information_schema.columns`: pg-mem
 *    reports `NO` for nullable columns, which is why
 *    `test/schema-parity.integration-spec.ts` compares names and types only.
 *
 * DRIVER DIFFERENCE WORTH REMEMBERING: `pg` returns BIGINT as a string (which is
 * why ids are typed `string` throughout the domain), while pg-mem returns a
 * JavaScript number. Compare ids with `String(id) === '42'` in pg-mem suites.
 */
export interface PgMemQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
  rowCount: number;
}

/**
 * The narrow slice of `pg.Pool` the application actually consumes. Suites hand
 * this to `.overrideProvider(DATABASE_POOL)`, so keeping it structural avoids a
 * cast at every call site.
 */
export interface PgMemPool {
  query<TRow = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgMemQueryResult<TRow>>;
  end?(): Promise<void>;
}

export interface PgMemHandle {
  readonly db: IMemoryDb;
  readonly pool: PgMemPool;
}

/**
 * Registers the PostgreSQL built-ins that pg-mem 3.0.5 does not ship but that
 * this codebase's DDL and legacy migration SQL reference.
 *
 * These are deliberately minimal reimplementations: they only have to be correct
 * for the inputs the schema and the suites produce, not for the full PostgreSQL
 * semantics (collations, POSIX classes, multibyte edge cases).
 */
function registerFunctionShims(db: IMemoryDb): void {
  const text = db.public.getType(DataType.text);

  db.public.registerFunction({
    name: 'btrim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string | null) => (value ?? '').trim(),
  });

  db.public.registerFunction({
    name: 'split_part',
    args: [DataType.text, DataType.text, DataType.integer],
    returns: DataType.text,
    implementation: (value: string | null, separator: string, position: number) =>
      (value ?? '').split(separator)[position - 1] ?? '',
  });

  db.public.registerFunction({
    name: 'translate',
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string | null, from: string, to: string) => {
      const source = [...from];
      const target = [...to];

      return [...(value ?? '')]
        .map((character) => {
          const index = source.indexOf(character);

          if (index === -1) {
            return character;
          }

          return target[index] ?? '';
        })
        .join('');
    },
  });

  // PostgreSQL replaces the first match without flags and every match with 'g'.
  db.public.registerFunction({
    name: 'regexp_replace',
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string | null, pattern: string, replacement: string) =>
      (value ?? '').replace(new RegExp(pattern), replacement),
  });

  db.public.registerFunction({
    name: 'regexp_replace',
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string | null, pattern: string, replacement: string, flags: string) =>
      (value ?? '').replace(new RegExp(pattern, flags), replacement),
  });

  // Returns the capture groups as a text[] , or NULL when the pattern does not match.
  db.public.registerFunction({
    name: 'regexp_match',
    args: [DataType.text, DataType.text],
    returns: text.asArray(),
    implementation: (value: string | null, pattern: string) => {
      const match = new RegExp(pattern).exec(value ?? '');

      return match ? match.slice(1) : null;
    },
  });

  // Identity shim: enough for `CREATE INDEX ... USING GIN (to_tsvector(...))` to
  // parse. pg-mem never uses the index, so no tokenization is required.
  db.public.registerFunction({
    name: 'to_tsvector',
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (_configuration: string, value: string | null) => value ?? '',
  });

  db.public.registerFunction({
    name: 'gen_random_uuid',
    args: [],
    returns: DataType.uuid,
    impure: true,
    implementation: () => randomUUID(),
  });

  /**
   * The Postgres side of the shared search normalizer (migration 0016). Binding
   * it to the TypeScript implementation is the point: the `entries`
   * `normalized_search_document` generated column then produces byte-identical
   * values under pg-mem and under PostgreSQL.
   */
  db.public.registerFunction({
    name: 'feedpulse_normalize_search_text',
    args: [DataType.text],
    returns: DataType.text,
    allowNullArguments: true,
    implementation: (value: string | null) => normalizeSearchText(value ?? ''),
  });
}

/**
 * Creates an isolated in-memory database plus a `pg`-compatible pool.
 *
 * `autoCreateForeignKeyIndices` mirrors what every suite already passed, and
 * `noAstCoverageCheck` stops pg-mem from rejecting SQL whose AST it parses but
 * does not fully walk (several repository statements land in that bucket).
 */
export function createPgMemPool(): PgMemHandle {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });

  registerFunctionShims(db);

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as PgMemPool;

  return { db, pool };
}
