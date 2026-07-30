import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { canonicalizeArticleLink } from '../src/modules/alerts/domain/canonical-article-link';
import { MIGRATIONS_DIR, resetSchemaWithMigrations } from './support/schema';

/**
 * The cross-implementation anti-drift spec. The alert dedupe key is computed
 * TWICE: by `canonicalizeArticleLink` for every alert written from now on, and
 * by `feedpulse_canonicalize_article_link` in migration 0018 for every row that
 * already existed. One byte of disagreement and the backfilled row stops
 * colliding with the freshly ingested row for the same article on
 * idx_alerts_tenant_dedupe_key_unique, so the tenant gets the duplicate alert
 * 0018 exists to prevent -- and they did disagree, because `URLSearchParams`
 * decoded and re-encoded the query and plpgsql did not. Both are driven here
 * through one corpus and required to return the same bytes. Point
 * `TEST_DATABASE_URL` at a throwaway database to run it; it skips otherwise.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const TEST_SCHEMA = 'canonical_parity';
const MIGRATION = '0018_alerts_canonical_relink_and_index_cleanup.sql';

/** Cases that differ only in the query; every one hangs off the same origin. */
const QUERY_CASES: readonly string[] = [
  // Percent-encoding, starting with the four the round-trip used to rewrite.
  ...['title=a%20b', 'p=%2fx', 'n=%41', 's=a%2Ab', 'p=%2Fx', 't=a+b', 'e=caf%C3%A9', 'k=a%7Eb', 'q=%', 't=a b'],
  ...['q=it%27s&r=%22x%22&s=%3Cy%3E', `q=it's&r="x"&s=<y>`, 'flag&=novalue&x=1&x=2', '', '&&b=1&&', 'b=1#frag'],
  // RAW non-ASCII in names and values. This is the dimension an earlier fix
  // missed: the WHATWG special-query encode set is not a short punctuation
  // list, it covers every code point above U+007E, so routing the query through
  // URL parsing produced 'q=okupaci%C3%B3n' here and raw bytes in plpgsql, and
  // the same Spanish article arrived twice. A Spanish/CJK news feed hits this on
  // ordinary search and tag links, so it is the common case, not an edge case.
  ...['q=okupación', 's=café&t=1', 'búsqueda=okupación&categoría=vivienda', 'q=中文', 'q=€50'],
  ...['ñ=1&n=2', 'Ä=1&Z=2', 'q=a\tb', 'q=naïve+café', 'título=Piso okupado en Málaga'],
  // Tracking parameters, including the case-insensitive name match.
  ...['utm_source=x&utm_medium=y&b=2&a=1', 'fbclid=a&gclid=b&mc_cid=1&mc_eid=2', 'UTM_SOURCE=X&Ref=k&utm_=1&utmx=2'],
  'ref=home&ref_src=twsrc&at_medium=rss&at_campaign=x&__twitter_impression=true',
  // Ordering: a glibc database sorts this one wrong without COLLATE "C".
  'a_b=1&aab=1&B=1&a=1&_z=1&Zz=1',
];

const PARITY_CORPUS: readonly string[] = [
  ...QUERY_CASES.map((query) => `https://example.com/a?${query}`),
  // Mixed-case hosts and schemes, default ports, www., punycode IDN.
  ...['https://Example.COM/Articles/AI-News', 'HTTPS://Example.com/A', 'http://example.com:80/a'],
  ...['https://example.com:443/a', 'https://example.com:8443/a', 'http://www.example.com/a'],
  ...['https://xn--bcher-kva.example.com/a', 'https://example.com//articles///ai-news//'],
  // Roots, trailing slashes and fragments; then malformed input, which falls
  // back to the hand-rolled parser on both sides.
  ...['https://example.com/', 'https://example.com/a/', 'https://example.com/a#comments'],
  ...['example.com/a?b=2&a=1&utm_source=x', '/articles//ai-news/#top', 'not a url at all'],
];

// Where the two DELIBERATELY disagree, all of it outside the query stage: the
// WHATWG parser punycodes an IDN host, appends the root path, escapes the path
// and resolves `..`, none of which plpgsql can. Pinned with both outputs so a
// change on either side surfaces here, not as a duplicate alert.
const KNOWN_DIVERGENCES: ReadonlyArray<readonly [string, string, string]> = [
  ['https://bücher.example.com/a', 'https://xn--bcher-kva.example.com/a', 'https://bücher.example.com/a'],
  ['https://example.com', 'https://example.com/', 'https://example.com'],
  ['https://example.com/a b?x=1', 'https://example.com/a%20b?x=1', 'https://example.com/a b?x=1'],
  ['https://example.com/../a', 'https://example.com/a', 'https://example.com/../a'],
];

describeWithDatabase('canonical article link parity between TypeScript and migration 0018', () => {
  let pool: Pool;
  let fromSql: Map<string, string | null>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${TEST_SCHEMA}` });
    await resetSchemaWithMigrations(pool, TEST_SCHEMA);

    // 0018 drops the function on its last line, so the definition under test is
    // re-executed out of the migration text instead of copied into this file.
    const sql = await readFile(join(MIGRATIONS_DIR, MIGRATION), 'utf8');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION feedpulse_canonicalize_article_link');
    expect(start).toBeGreaterThanOrEqual(0);
    await pool.query(sql.slice(start, sql.indexOf('$$;', start) + 3));

    const { rows } = await pool.query<{ input: string; out: string | null }>(
      `SELECT u AS input, feedpulse_canonicalize_article_link(u) AS out FROM unnest($1::text[]) AS u`,
      [[...PARITY_CORPUS, ...KNOWN_DIVERGENCES.map(([input]) => input)]],
    );
    fromSql = new Map(rows.map((row) => [row.input, row.out]));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('returns byte-identical canonical links for all 45 corpus URLs', () => {
    // Pinned so shrinking the corpus is a visible failure rather than a quiet
    // loss of coverage. Raise it when adding cases; never lower it.
    expect(new Set(PARITY_CORPUS).size).toBe(45);

    const mismatches = PARITY_CORPUS.filter((url) => canonicalizeArticleLink(url) !== fromSql.get(url)).map(
      (url) => `${url}\n    typescript: ${canonicalizeArticleLink(url)}\n    plpgsql   : ${fromSql.get(url)}`,
    );

    expect(mismatches).toEqual([]);
  });

  it('still diverges only where the divergence is documented', () => {
    const observed = KNOWN_DIVERGENCES.map(([input]) => [input, canonicalizeArticleLink(input), fromSql.get(input)]);

    expect(observed).toEqual(KNOWN_DIVERGENCES.map((row) => [...row]));
  });
});
