import { RulesRepository } from '../src/modules/rules/rules.repository';

/**
 * Safety net for the tenant-scoped CRUD of `rules`.
 *
 * The repository writes raw SQL, so these tests assert on the SQL text and on
 * the bound parameters: a dropped `tenant_id` predicate or a shifted `$n`
 * placeholder is a cross-tenant data leak, and neither is visible from the
 * mapped return value alone. Predicates use tolerant regexes (whitespace and
 * reformatting are harmless), while parameter arrays are compared exactly.
 */

interface RuleRowShape {
  id: number;
  tenant_id: string;
  name: string;
  include_keywords: string[];
  exclude_keywords: string[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function makeRow(overrides: Partial<RuleRowShape> = {}): RuleRowShape {
  return {
    id: 1,
    tenant_id: 'tenant-A',
    name: 'Eviction rule',
    include_keywords: ['desahucio'],
    exclude_keywords: [],
    is_active: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function setup(...results: Array<{ rows: unknown[]; rowCount?: number }>) {
  const queryMock = jest.fn();

  if (results.length === 0) {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  } else {
    for (const result of results) {
      queryMock.mockResolvedValueOnce({ rowCount: result.rows.length, ...result });
    }
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  }

  const repository = new RulesRepository({ query: queryMock } as never);
  return { repository, queryMock };
}

function callAt(queryMock: jest.Mock, index: number): [string, unknown[] | undefined] {
  return queryMock.mock.calls[index] as [string, unknown[] | undefined];
}

describe('RulesRepository.create', () => {
  it('binds the tenant first and maps the returned row into the domain shape', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow()] });

    const created = await repository.create({
      tenantId: 'tenant-A',
      name: 'Eviction rule',
      includeKeywords: ['desahucio'],
      excludeKeywords: ['turistica'],
      isActive: true,
    });

    expect(created).toEqual({
      id: 1,
      name: 'Eviction rule',
      includeKeywords: ['desahucio'],
      excludeKeywords: [],
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/INSERT\s+INTO\s+rules/);
    expect(sql).toMatch(/\(\s*tenant_id\s*,\s*name\s*,\s*include_keywords\s*,\s*exclude_keywords\s*,\s*is_active\s*\)/);
    expect(params).toEqual(['tenant-A', 'Eviction rule', ['desahucio'], ['turistica'], true]);
  });
});

describe('RulesRepository.list', () => {
  it('always scopes to the tenant and keeps pagination parameters after the filters', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow()] }, { rows: [{ count: '1' }] });

    const result = await repository.list({ tenantId: 'tenant-A', page: 2, pageSize: 10 });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);

    const [itemsSql, itemsParams] = callAt(queryMock, 0);
    expect(itemsSql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(itemsSql).toMatch(/LIMIT\s+\$2\s+OFFSET\s+\$3/);
    // page 2 with pageSize 10 => OFFSET 10.
    expect(itemsParams).toEqual(['tenant-A', 10, 10]);

    const [countSql, countParams] = callAt(queryMock, 1);
    expect(countSql).toMatch(/COUNT\(\*\)/);
    expect(countSql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    // The count query must carry the very same predicate and bindings, or the
    // pagination total describes a different set than the page it labels.
    expect(countParams).toEqual(['tenant-A']);
  });

  it('appends the is_active filter as $2 without displacing the tenant binding', async () => {
    const { repository, queryMock } = setup({ rows: [] }, { rows: [{ count: '0' }] });

    await repository.list({ tenantId: 'tenant-A', page: 1, pageSize: 25, isActive: false });

    const [itemsSql, itemsParams] = callAt(queryMock, 0);
    expect(itemsSql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+is_active\s*=\s*\$2/);
    expect(itemsParams).toEqual(['tenant-A', false, 25, 0]);
  });

  it('wraps the free-text query in wildcards and binds it after the other filters', async () => {
    const { repository, queryMock } = setup({ rows: [] }, { rows: [{ count: '0' }] });

    await repository.list({ tenantId: 'tenant-A', page: 1, pageSize: 25, isActive: true, query: 'vivienda' });

    const [itemsSql, itemsParams] = callAt(queryMock, 0);
    expect(itemsSql).toMatch(/name\s+ILIKE\s+\$3/);
    expect(itemsParams).toEqual(['tenant-A', true, '%vivienda%', 25, 0]);
  });

  it('reports a total of zero when the count query returns nothing', async () => {
    const { repository } = setup({ rows: [] }, { rows: [] });

    const result = await repository.list({ tenantId: 'tenant-A', page: 1, pageSize: 25 });

    expect(result.total).toBe(0);
  });
});

describe('RulesRepository.listActive', () => {
  it('filters by tenant and by is_active, binding the tenant as $1', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow()] });

    const rules = await repository.listActive('tenant-A');

    expect(rules).toHaveLength(1);
    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
    expect(sql).toContain('is_active = true');
    expect(params).toEqual(['tenant-A']);
  });

  it('returns an empty list without losing the tenant predicate', async () => {
    const { repository, queryMock } = setup({ rows: [] });

    const rules = await repository.listActive('tenant-A');

    expect(rules).toEqual([]);
    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(params).toEqual(['tenant-A']);
  });

  it('orders deterministically by id so the matcher sees a stable rule set', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow({ id: 1 }), makeRow({ id: 2 })] });

    const rules = await repository.listActive('tenant-A');

    expect(rules.map((rule) => rule.id)).toEqual([1, 2]);
    const [sql] = callAt(queryMock, 0);
    expect(sql).toMatch(/ORDER\s+BY\s+id\s+ASC/);
  });
});

describe('RulesRepository.findByName', () => {
  it('looks a rule up by tenant and name and limits to a single row', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow({ name: 'Eviction rule' })] });

    const rule = await repository.findByName('Eviction rule', 'tenant-A');

    expect(rule?.name).toBe('Eviction rule');
    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+name\s*=\s*\$2/);
    expect(sql).toMatch(/LIMIT\s+1/);
    // Argument order is (name, tenantId) but binding order is (tenantId, name):
    // swapping them silently returns another tenant's rule.
    expect(params).toEqual(['tenant-A', 'Eviction rule']);
  });

  it('returns null when the tenant has no rule with that name', async () => {
    const { repository } = setup({ rows: [] });

    await expect(repository.findByName('Missing', 'tenant-A')).resolves.toBeNull();
  });
});

/**
 * These cases used to assert a read-then-write: `findByName`, then either `create` or `update`.
 * That shape was the bug — with no uniqueness rule behind it, two concurrent OPML imports could
 * both read "absent" and both insert. Migration 0020 adds `idx_rules_tenant_name_unique` and the
 * method is now one `INSERT ... ON CONFLICT (tenant_id, name) DO UPDATE`, so what has to be
 * asserted changed with it: the absence of a second round trip is the fix.
 */
describe('RulesRepository.upsertByName', () => {
  it('resolves insert-or-update inside one statement, with the tenant bound first', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow({ id: 9, name: 'New rule' })] });

    const rule = await repository.upsertByName({
      tenantId: 'tenant-A',
      name: 'New rule',
      includeKeywords: ['ocupacion'],
      excludeKeywords: [],
      isActive: true,
    });

    expect(rule.id).toBe(9);
    // Two calls would be the race back: a separate read leaves a window before the write.
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/INSERT\s+INTO\s+rules/);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*name\s*\)\s+DO\s+UPDATE/i);
    expect(params).toEqual(['tenant-A', 'New rule', ['ocupacion'], [], true]);
  });

  it('never writes back the conflict key or the creation timestamp on the update branch', async () => {
    const { repository, queryMock } = setup({
      rows: [makeRow({ id: 4, name: 'Eviction rule', include_keywords: ['ocupacion'], is_active: false })],
    });

    const rule = await repository.upsertByName({
      tenantId: 'tenant-A',
      name: 'Eviction rule',
      includeKeywords: ['ocupacion'],
      excludeKeywords: [],
      isActive: false,
    });

    expect(rule.id).toBe(4);
    expect(rule.includeKeywords).toEqual(['ocupacion']);

    const [sql] = callAt(queryMock, 0);
    // `name` is the conflict key and `created_at` is history: rewriting either would make an
    // upsert look like a brand new rule.
    expect(sql).not.toMatch(/SET[\s\S]*\bname\s*=/i);
    expect(sql).not.toMatch(/created_at\s*=/i);
    expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i);
  });

  it('fails loudly when the statement returns no row', async () => {
    const { repository } = setup({ rows: [] });

    await expect(
      repository.upsertByName({
        tenantId: 'tenant-A',
        name: 'Eviction rule',
        includeKeywords: [],
        excludeKeywords: [],
        isActive: true,
      }),
    ).rejects.toThrow('rule_upsert_failed');
  });
});

describe('RulesRepository.findById', () => {
  it('binds tenant_id as $1 and id as $2 on the tenant-scoped branch', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow({ id: 42 })] });

    const rule = await repository.findById(42, 'tenant-A');

    expect(rule?.id).toBe(42);
    const [sql, params] = callAt(queryMock, 0);
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(params).toEqual(['tenant-A', 42]);
  });

  it('keeps the tenant binding even when nothing is found', async () => {
    const { repository, queryMock } = setup({ rows: [] });

    await expect(repository.findById(999, 'tenant-A')).resolves.toBeNull();
    const [, params] = callAt(queryMock, 0);
    expect(params).toEqual(['tenant-A', 999]);
  });
});

describe('RulesRepository.update', () => {
  it('writes the new values while keeping the tenant guard in the WHERE clause', async () => {
    const { repository, queryMock } = setup(
      { rows: [makeRow({ name: 'Original rule' })] },
      { rows: [makeRow({ name: 'Updated rule', is_active: false })] },
    );

    const updated = await repository.update({
      id: 1,
      tenantId: 'tenant-A',
      name: 'Updated rule',
      isActive: false,
    });

    expect(updated?.name).toBe('Updated rule');
    expect(updated?.isActive).toBe(false);

    const [updateSql, updateParams] = callAt(queryMock, 1);
    expect(updateSql).toMatch(/UPDATE\s+rules/);
    expect(updateSql).toMatch(/WHERE\s+id\s*=\s*\$1/);
    // The tenant predicate is unconditional: there is no cross-tenant update path.
    expect(updateSql).toMatch(/AND\s+tenant_id\s*=\s*\$6/);
    expect(updateParams).toEqual([1, 'Updated rule', ['desahucio'], [], false, 'tenant-A']);
  });

  it('falls back to the current values for every field left undefined', async () => {
    const current = makeRow({
      name: 'Original rule',
      include_keywords: ['a'],
      exclude_keywords: ['b'],
      is_active: true,
    });
    const { repository, queryMock } = setup({ rows: [current] }, { rows: [current] });

    await repository.update({ id: 1, tenantId: 'tenant-A' });

    const [, updateParams] = callAt(queryMock, 1);
    expect(updateParams).toEqual([1, 'Original rule', ['a'], ['b'], true, 'tenant-A']);
  });

  it('reads the current row through the tenant-scoped lookup before writing', async () => {
    const current = makeRow();
    const { repository, queryMock } = setup({ rows: [current] }, { rows: [current] });

    await repository.update({ id: 1, tenantId: 'tenant-A', isActive: false });

    // A rule belonging to another tenant is invisible here, so the UPDATE is
    // never reached for it.
    const [lookupSql, lookupParams] = callAt(queryMock, 0);
    expect(lookupSql).toMatch(/SELECT\s+\*\s+FROM\s+rules\s+WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
    expect(lookupParams).toEqual(['tenant-A', 1]);
  });

  it('returns null and issues no UPDATE when the rule is not visible to the tenant', async () => {
    const { repository, queryMock } = setup({ rows: [] });

    await expect(repository.update({ id: 999, tenantId: 'tenant-A' })).resolves.toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('RulesRepository.disable', () => {
  it('delegates to update with isActive=false and keeps the tenant binding', async () => {
    const { repository, queryMock } = setup({ rows: [makeRow()] }, { rows: [makeRow({ is_active: false })] });

    await expect(repository.disable(1, 'tenant-A')).resolves.toBe(true);

    const [updateSql, updateParams] = callAt(queryMock, 1);
    expect(updateSql).toMatch(/UPDATE\s+rules/);
    expect(updateSql).toContain('is_active = $5');
    expect(updateParams?.[0]).toBe(1);
    expect(updateParams?.[4]).toBe(false);
    expect(updateParams?.[5]).toBe('tenant-A');
  });

  it('returns false when the rule does not belong to the tenant', async () => {
    const { repository } = setup({ rows: [] });

    await expect(repository.disable(999, 'tenant-A')).resolves.toBe(false);
  });
});
