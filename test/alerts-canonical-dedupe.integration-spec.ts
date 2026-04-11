import { newDb } from 'pg-mem';

import { AlertsRepository } from '../src/modules/alerts/alerts.repository';

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

async function bootstrapSchema(pool: Queryable): Promise<void> {
  await pool.query(`
    CREATE TABLE entries (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      feed_id INT NOT NULL,
      title TEXT,
      link TEXT,
      content_hash TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE rules (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      include_keywords TEXT[] NOT NULL,
      exclude_keywords TEXT[] NOT NULL DEFAULT '{}'
    )
  `);

  await pool.query(`
    CREATE TABLE alerts (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entry_id BIGINT NOT NULL REFERENCES entries(id),
      rule_id INT NOT NULL REFERENCES rules(id),
      canonical_link TEXT,
      sent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entry_id, rule_id)
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX idx_alerts_tenant_rule_canonical_link_unique
    ON alerts (tenant_id, rule_id, canonical_link)
    WHERE canonical_link IS NOT NULL
  `);
}

describe('AlertsRepository canonical-link dedupe', () => {
  let pool: Queryable;
  let repository: AlertsRepository;

  beforeEach(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();
    await bootstrapSchema(pool);

    repository = new AlertsRepository({ query: pool.query.bind(pool) } as never);

    await pool.query(`
      INSERT INTO rules (id, tenant_id, name, include_keywords, exclude_keywords)
      VALUES
        (1, 'tenant_a', 'Rule A', ARRAY['ai'], ARRAY[]::text[]),
        (2, 'tenant_a', 'Rule B', ARRAY['ai'], ARRAY[]::text[])
    `);
  });

  it('creates a single alert for duplicate entries with same canonical link and same rule', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash)
      VALUES
        (101, 'tenant_a', 1, 'A', 'https://Example.com/articles/ai-news/#top', 'hash_101'),
        (102, 'tenant_a', 2, 'B', 'https://example.com/articles/ai-news', 'hash_102')
    `);

    const created = await repository.createForMatches([
      { entryId: '101', ruleId: 1 },
      { entryId: '102', ruleId: 1 },
    ]);

    expect(created).toHaveLength(1);

    const rows = await pool.query(`SELECT entry_id, rule_id, canonical_link FROM alerts ORDER BY id ASC`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual(
      expect.objectContaining({
        entry_id: 101,
        rule_id: 1,
        canonical_link: 'https://example.com/articles/ai-news',
      }),
    );
  });

  it('allows the same canonical link to alert for different rules', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash)
      VALUES
        (201, 'tenant_a', 1, 'A', 'https://example.com/articles/shared', 'hash_201'),
        (202, 'tenant_a', 2, 'B', 'https://example.com/articles/shared/#dup', 'hash_202')
    `);

    const created = await repository.createForMatches([
      { entryId: '201', ruleId: 1 },
      { entryId: '202', ruleId: 2 },
    ]);

    expect(created).toHaveLength(2);

    const rows = await pool.query(`SELECT rule_id, canonical_link FROM alerts ORDER BY rule_id ASC`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toEqual(expect.objectContaining({ rule_id: 1, canonical_link: 'https://example.com/articles/shared' }));
    expect(rows.rows[1]).toEqual(expect.objectContaining({ rule_id: 2, canonical_link: 'https://example.com/articles/shared' }));
  });

  it('falls back to per-entry dedupe when link is null or empty', async () => {
    await pool.query(`
      INSERT INTO entries (id, tenant_id, feed_id, title, link, content_hash)
      VALUES
        (301, 'tenant_a', 1, 'No Link', NULL, 'hash_301'),
        (302, 'tenant_a', 2, 'Empty Link', '   ', 'hash_302')
    `);

    const created = await repository.createForMatches([
      { entryId: '301', ruleId: 1 },
      { entryId: '302', ruleId: 1 },
      { entryId: '301', ruleId: 1 },
    ]);

    expect(created).toHaveLength(2);

    const rows = await pool.query(`SELECT entry_id, rule_id, canonical_link FROM alerts ORDER BY entry_id ASC`);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toEqual(expect.objectContaining({ entry_id: 301, rule_id: 1, canonical_link: null }));
    expect(rows.rows[1]).toEqual(expect.objectContaining({ entry_id: 302, rule_id: 1, canonical_link: null }));
  });
});
