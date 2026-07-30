import { Pool } from 'pg';
import { AlertsRepository } from '../src/modules/alerts/alerts.repository';
import { expectDefined } from './support/expect-defined';
import { resetSchemaWithMigrations } from './support/schema';

/**
 * These cases exercise `createForEntryWithRules` against the real schema,
 * because the behaviour under test *is* SQL: `ON CONFLICT` inference over the
 * expression index created by migration 0018, the `matched_rules` union, and the
 * `xmax = 0` test that separates a genuinely new alert from one that only gained
 * a rule. `pg-mem` implements none of those, so emulating them would only assert
 * that the emulator matches itself.
 *
 * Point `TEST_DATABASE_URL` (or `DATABASE_URL`) at a throwaway Postgres 13+
 * database to run them; the suite skips otherwise. The database is wiped: never
 * aim it at anything you care about.
 */
const databaseUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('AlertsRepository.createForEntryWithRules canonical-link dedupe', () => {
  let pool: Pool;
  let repository: AlertsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await resetSchemaWithMigrations(pool, 'public');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE alerts, entries, rules, feeds RESTART IDENTITY CASCADE');
    await pool.query(`
      INSERT INTO feeds (id, tenant_id, url) VALUES
        (1, 'tenant_a', 'https://newswire.example.com/rss'),
        (2, 'tenant_a', 'https://aggregator.example.com/rss'),
        (3, 'tenant_b', 'https://newswire.example.com/rss-b')
    `);
    await pool.query(`
      INSERT INTO rules (id, tenant_id, name, include_keywords) VALUES
        (1, 'tenant_a', 'Rule A', ARRAY['ai']),
        (2, 'tenant_a', 'Rule B', ARRAY['llm']),
        (3, 'tenant_b', 'Rule C', ARRAY['ai'])
    `);

    repository = new AlertsRepository({
      query: (text: string, values?: unknown[]) => pool.query(text, values),
    } as never);
  });

  it('collapses two entries with the same canonical link into one alert carrying every rule', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash) VALUES
        (101, 'tenant_a', 1, 'A', 'https://Example.com/articles/ai-news/?utm_source=newsletter#top', 'hash_101'),
        (102, 'tenant_a', 2, 'B', 'https://example.com//articles/ai-news?fbclid=xyz', 'hash_102')
    `);

    const outcome = await repository.createForEntryWithRules(
      new Map([
        ['101', [1]],
        ['102', [2]],
      ]),
    );

    expect(outcome.created).toHaveLength(1);
    expect(outcome.ruleSetExtended).toHaveLength(0);

    const rows = await pool.query('SELECT entry_id::text AS entry_id, matched_rules, canonical_link FROM alerts');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({
      entry_id: '101',
      matched_rules: [1, 2],
      canonical_link: 'https://example.com/articles/ai-news',
    });
  });

  it('appends a rule to an existing alert without losing the previous ones and without re-delivering', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash) VALUES
        (201, 'tenant_a', 1, 'A', 'https://example.com/articles/shared', 'hash_201'),
        (202, 'tenant_a', 2, 'B', 'https://example.com/articles/shared/', 'hash_202')
    `);

    const first = await repository.createForEntryWithRules(new Map([['201', [1]]]));
    const second = await repository.createForEntryWithRules(new Map([['202', [2]]]));

    expect(first.created).toHaveLength(1);
    expect(first.ruleSetExtended).toHaveLength(0);

    // The second call must not report a new alert: the article was already
    // delivered and only its rule set grew.
    expect(second.created).toHaveLength(0);
    expect(second.ruleSetExtended).toHaveLength(1);
    expect(expectDefined(second.ruleSetExtended[0]).id).toBe(expectDefined(first.created[0]).id);

    const rows = await pool.query('SELECT matched_rules FROM alerts');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].matched_rules).toEqual([1, 2]);
  });

  it('keeps the same canonical link separate across tenants', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash) VALUES
        (301, 'tenant_a', 1, 'A', 'https://example.com/articles/shared', 'hash_301'),
        (302, 'tenant_b', 3, 'B', 'https://example.com/articles/shared', 'hash_302')
    `);

    const outcome = await repository.createForEntryWithRules(
      new Map([
        ['301', [1]],
        ['302', [3]],
      ]),
    );

    expect(outcome.created).toHaveLength(2);

    const rows = await pool.query('SELECT tenant_id, canonical_link FROM alerts ORDER BY tenant_id');
    expect(rows.rows).toEqual([
      { tenant_id: 'tenant_a', canonical_link: 'https://example.com/articles/shared' },
      { tenant_id: 'tenant_b', canonical_link: 'https://example.com/articles/shared' },
    ]);
  });

  it('falls back to per-entry dedupe when the link is missing or blank', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash) VALUES
        (401, 'tenant_a', 1, 'No link', NULL, 'hash_401'),
        (402, 'tenant_a', 2, 'Blank link', '   ', 'hash_402')
    `);

    const first = await repository.createForEntryWithRules(
      new Map([
        ['401', [1]],
        ['402', [1]],
      ]),
    );

    // Two link-less entries are two different articles: one alert each.
    expect(first.created).toHaveLength(2);

    // Re-alerting the same link-less entry must not create a second alert.
    const second = await repository.createForEntryWithRules(new Map([['401', [2]]]));
    expect(second.created).toHaveLength(0);
    expect(second.ruleSetExtended).toHaveLength(1);

    const rows = await pool.query(
      'SELECT entry_id::text AS entry_id, matched_rules, canonical_link FROM alerts ORDER BY entry_id',
    );
    expect(rows.rows).toEqual([
      { entry_id: '401', matched_rules: [1, 2], canonical_link: null },
      { entry_id: '402', matched_rules: [1], canonical_link: null },
    ]);
  });

  it('collapses entries that share a canonical link inside a single batch', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash) VALUES
        (501, 'tenant_a', 1, 'A', 'https://example.com/articles/dup?utm_source=a', 'hash_501'),
        (502, 'tenant_a', 1, 'B', 'https://example.com/articles/dup?utm_source=b', 'hash_502')
    `);

    // Postgres refuses an ON CONFLICT DO UPDATE that touches the same row twice
    // in one statement, so the repository must merge these before writing.
    const outcome = await repository.createForEntryWithRules(
      new Map([
        ['501', [1]],
        ['502', [2]],
      ]),
    );

    expect(outcome.created).toHaveLength(1);

    const rows = await pool.query('SELECT matched_rules FROM alerts');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].matched_rules).toEqual([1, 2]);
  });

  it('returns nothing when no entry has matching rules', async () => {
    await expect(repository.createForEntryWithRules(new Map())).resolves.toEqual({ created: [], ruleSetExtended: [] });
    await expect(repository.createForEntryWithRules(new Map([['999', []]]))).resolves.toEqual({
      created: [],
      ruleSetExtended: [],
    });
  });
});
