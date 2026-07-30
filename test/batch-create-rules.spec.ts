import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ENTRY_SEARCH_MAX_LENGTH, ListEntriesQueryDto } from '../src/modules/entries/dto/list-entries.query';
import { BatchCreateRulesUseCase } from '../src/modules/rules/application/batch-create-rules.use-case';
import { BATCH_CREATE_RULES_MAX_ITEMS, BatchCreateRulesDto } from '../src/modules/rules/dto/batch-create-rules.dto';
import { CreateRuleDto, RULE_KEYWORD_MAX_LENGTH } from '../src/modules/rules/dto/create-rule.dto';
import { UpdateRuleDto } from '../src/modules/rules/dto/update-rule.dto';
import type { RuleDraft } from '../src/modules/rules/rules.repository';
import { RulesRepository } from '../src/modules/rules/rules.repository';
import { expectDefined } from './support/expect-defined';

/**
 * Unit half of the batch-rules unit: the SQL the repository emits, the accounting it derives
 * from the rows that come back, and the DTO limits that stop a payload before it reaches either.
 *
 * The end-to-end half — real HTTP status codes over a booted Nest app, and migration 0020 against
 * a real PostgreSQL — lives in `test/rules-batch.integration-spec.ts`, because this project routes
 * anything that boots a container or a database to the integration project.
 *
 * Constraint checks here go through `plainToInstance` + `validateSync`, which is exactly what
 * Nest's global `ValidationPipe` runs (`whitelist: true, transform: true` in `app.module.ts`).
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

let nextRowId = 1;

function makeRow(overrides: Partial<RuleRowShape> = {}): RuleRowShape {
  return {
    id: nextRowId++,
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

/**
 * Stands in for a database that already holds `existingNames` for the tenant.
 *
 * It reproduces the one behaviour the statement depends on: the `LEFT JOIN ... IS NULL` filter
 * removes names that already exist, so `RETURNING` describes the inserted rows and nothing else.
 */
function setupInsert(existingNames: readonly string[] = []) {
  const queryMock = jest.fn(async (_sql: string, values: unknown[] = []) => {
    const tenantId = values[0] as string;
    const rows: RuleRowShape[] = [];

    for (let index = 1; index < values.length; index += 4) {
      const name = values[index] as string;

      if (existingNames.includes(name)) {
        continue;
      }

      rows.push(
        makeRow({
          tenant_id: tenantId,
          name,
          include_keywords: values[index + 1] as string[],
          exclude_keywords: values[index + 2] as string[],
          is_active: values[index + 3] as boolean,
        }),
      );
    }

    return { rows, rowCount: rows.length };
  });

  const repository = new RulesRepository({ query: queryMock } as never);
  return { repository, queryMock };
}

function draft(name: string, overrides: Partial<RuleDraft> = {}): RuleDraft {
  return { name, includeKeywords: ['ai'], excludeKeywords: [], isActive: true, ...overrides };
}

function firstCall(queryMock: jest.Mock): [string, unknown[]] {
  return queryMock.mock.calls[0] as [string, unknown[]];
}

beforeEach(() => {
  nextRowId = 1;
});

describe('RulesRepository.insertIgnoreOnConflict', () => {
  it('creates every rule of a full 50-item batch in a single statement', async () => {
    const { repository, queryMock } = setupInsert();
    const drafts = Array.from({ length: BATCH_CREATE_RULES_MAX_ITEMS }, (_value, index) => draft(`Rule ${index}`));

    const result = await repository.insertIgnoreOnConflict(drafts, 'tenant-A');

    expect(result.created).toHaveLength(BATCH_CREATE_RULES_MAX_ITEMS);
    expect(result.skippedNames).toEqual([]);
    expect(result.duplicateNames).toEqual([]);

    // One round trip, not fifty: the whole batch is one INSERT, which is what makes it atomic
    // without an explicit transaction or a checked-out client.
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [sql, values] = firstCall(queryMock);
    expect(sql).toMatch(/INSERT\s+INTO\s+rules/);
    expect((sql.match(/\$\d+::text\[\]/g) ?? []).length).toBe(BATCH_CREATE_RULES_MAX_ITEMS * 2);
    // $1 is the tenant, then four placeholders per rule.
    expect(values).toHaveLength(1 + BATCH_CREATE_RULES_MAX_ITEMS * 4);
    expect(values[0]).toBe('tenant-A');
  });

  it('reports a name the tenant already uses as skipped and never writes over it', async () => {
    const { repository, queryMock } = setupInsert(['Eviction rule']);

    const result = await repository.insertIgnoreOnConflict(
      [draft('Eviction rule', { includeKeywords: ['hijacked'] }), draft('Squatting watch')],
      'tenant-A',
    );

    expect(result.created.map((rule) => rule.name)).toEqual(['Squatting watch']);
    expect(result.skippedNames).toEqual(['Eviction rule']);
    expect(result.duplicateNames).toEqual([]);

    const [sql] = firstCall(queryMock);
    // Create-only: an UPDATE or a DO UPDATE branch here would let a batch silently rewrite a
    // rule the caller never intended to touch.
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*name\s*\)\s+DO\s+NOTHING/i);
    expect(sql).not.toMatch(/DO\s+UPDATE/i);
    expect(sql).not.toMatch(/UPDATE\s+rules/i);
  });

  it('collapses two identical names inside one batch into a single create', async () => {
    const { repository, queryMock } = setupInsert();

    const result = await repository.insertIgnoreOnConflict(
      [
        draft('Evictions', { includeKeywords: ['first'] }),
        draft('Evictions', { includeKeywords: ['second'] }),
        draft('Other'),
      ],
      'tenant-A',
    );

    expect(result.created.map((rule) => rule.name)).toEqual(['Evictions', 'Other']);
    // First occurrence wins, so the payload order decides which keywords are stored.
    expect(expectDefined(result.created[0]).includeKeywords).toEqual(['first']);
    expect(result.duplicateNames).toEqual(['Evictions']);
    // A collapsed name was still created, so it must not also appear as skipped: the three lists
    // are disjoint or the response cannot be read without reconciling them.
    expect(result.skippedNames).toEqual([]);

    const [, values] = firstCall(queryMock);
    expect(values).toHaveLength(1 + 2 * 4);
  });

  it('reports a name that is both duplicated in the batch and already stored exactly once each way', async () => {
    const { repository } = setupInsert(['Evictions']);

    const result = await repository.insertIgnoreOnConflict([draft('Evictions'), draft('Evictions')], 'tenant-A');

    expect(result.created).toEqual([]);
    expect(result.skippedNames).toEqual(['Evictions']);
    expect(result.duplicateNames).toEqual(['Evictions']);
  });

  it('binds the tenant once and reuses it on both sides of the join', async () => {
    const { repository, queryMock } = setupInsert();

    await repository.insertIgnoreOnConflict([draft('Only rule')], 'tenant-A');

    const [sql, values] = firstCall(queryMock);
    expect(sql).toMatch(/INSERT\s+INTO\s+rules[\s\S]*SELECT\s+\$1\s*,/);
    expect(sql).toMatch(/LEFT\s+JOIN\s+rules\s+existing[\s\S]*existing\.tenant_id\s*=\s*\$1/);
    expect(sql).toMatch(/WHERE\s+existing\.id\s+IS\s+NULL/);
    // No literal interpolation anywhere: every rule value is a bound parameter.
    expect(sql).not.toContain('Only rule');
    expect(values).toEqual(['tenant-A', 'Only rule', ['ai'], [], true]);
  });

  it('issues no statement at all for an empty draft list', async () => {
    const { repository, queryMock } = setupInsert();

    await expect(repository.insertIgnoreOnConflict([], 'tenant-A')).resolves.toEqual({
      created: [],
      skippedNames: [],
      duplicateNames: [],
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('RulesRepository.upsertByName', () => {
  it('resolves the conflict inside one statement instead of reading before writing', async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [makeRow({ id: 4, name: 'Eviction rule' })], rowCount: 1 });
    const repository = new RulesRepository({ query: queryMock } as never);

    const rule = await repository.upsertByName({
      tenantId: 'tenant-A',
      name: 'Eviction rule',
      includeKeywords: ['ocupacion'],
      excludeKeywords: [],
      isActive: true,
    });

    expect(rule.id).toBe(4);
    // A second round trip is the race: two importers could both read "absent" and both insert.
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [sql, values] = firstCall(queryMock);
    expect(sql).toMatch(/INSERT\s+INTO\s+rules/);
    expect(sql).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*name\s*\)\s+DO\s+UPDATE/i);
    // `name` is the conflict key and `created_at` is history: neither may be written back.
    expect(sql).not.toMatch(/SET[\s\S]*\bname\s*=/i);
    expect(sql).not.toMatch(/created_at\s*=/i);
    expect(values).toEqual(['tenant-A', 'Eviction rule', ['ocupacion'], [], true]);
  });

  it('fails loudly when the statement returns no row', async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repository = new RulesRepository({ query: queryMock } as never);

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

describe('BatchCreateRulesUseCase', () => {
  it('forwards the drafts and the tenant to the create-only repository method', async () => {
    const insertIgnoreOnConflict = jest.fn().mockResolvedValue({ created: [], skippedNames: [], duplicateNames: [] });
    const useCase = new BatchCreateRulesUseCase({ insertIgnoreOnConflict } as unknown as RulesRepository);

    await useCase.execute({ tenantId: 'tenant-A', rules: [draft('Only rule')] });

    expect(insertIgnoreOnConflict).toHaveBeenCalledWith([draft('Only rule')], 'tenant-A');
  });
});

/**
 * Every failed constraint, as both its class-validator key and its message, including the ones
 * nested one level down by `@ValidateNested`.
 *
 * The messages matter as much as the keys: `AllExceptionsFilter` promotes a single snake_case
 * validation message to the `code` of the 400 envelope, so `rule_keyword_too_long` is part of the
 * API contract rather than prose.
 */
function constraintKeys(dto: object): string[] {
  return validateSync(dto, { whitelist: true })
    .flatMap((error) => [error, ...(error.children ?? []).flatMap((child) => child.children ?? [])])
    .flatMap((error) => Object.entries(error.constraints ?? {}))
    .flatMap(([key, message]) => [key, message]);
}

describe('BatchCreateRulesDto limits', () => {
  function batchOf(count: number): BatchCreateRulesDto {
    return plainToInstance(BatchCreateRulesDto, {
      rules: Array.from({ length: count }, (_value, index) => ({
        name: `Rule ${index}`,
        include_keywords: ['ai'],
      })),
    });
  }

  it('accepts a batch of exactly 50 rules', () => {
    expect(validateSync(batchOf(BATCH_CREATE_RULES_MAX_ITEMS), { whitelist: true })).toEqual([]);
  });

  it('rejects a batch of 51 rules', () => {
    expect(constraintKeys(batchOf(BATCH_CREATE_RULES_MAX_ITEMS + 1))).toContain('arrayMaxSize');
  });

  it('rejects an empty batch', () => {
    expect(constraintKeys(batchOf(0))).toContain('arrayNotEmpty');
  });

  it('applies every per-rule constraint to each nested item', () => {
    const dto = plainToInstance(BatchCreateRulesDto, {
      rules: [
        { name: 'Fine', include_keywords: ['ai'] },
        { name: 'Too long a keyword', include_keywords: ['x'.repeat(RULE_KEYWORD_MAX_LENGTH + 1)] },
      ],
    });

    expect(constraintKeys(dto)).toContain('maxLength');
  });
});

describe('rule keyword and name bounds', () => {
  it.each([
    ['CreateRuleDto', CreateRuleDto],
    ['UpdateRuleDto', UpdateRuleDto],
  ])('%s accepts a keyword of exactly 200 characters', (_label, dtoClass) => {
    const dto = plainToInstance(dtoClass, {
      name: 'Boundary',
      include_keywords: ['k'.repeat(RULE_KEYWORD_MAX_LENGTH)],
      exclude_keywords: ['x'.repeat(RULE_KEYWORD_MAX_LENGTH)],
    });

    expect(validateSync(dto, { whitelist: true })).toEqual([]);
  });

  it.each([
    ['CreateRuleDto', CreateRuleDto],
    ['UpdateRuleDto', UpdateRuleDto],
  ])('%s rejects an include keyword over 200 characters', (_label, dtoClass) => {
    const dto = plainToInstance(dtoClass, {
      name: 'Oversized',
      include_keywords: ['ok', 'k'.repeat(RULE_KEYWORD_MAX_LENGTH + 1)],
    });

    expect(constraintKeys(dto)).toContain('rule_keyword_too_long');
  });

  it.each([
    ['CreateRuleDto', CreateRuleDto],
    ['UpdateRuleDto', UpdateRuleDto],
  ])('%s rejects an exclude keyword over 200 characters', (_label, dtoClass) => {
    const dto = plainToInstance(dtoClass, {
      name: 'Oversized',
      include_keywords: ['ok'],
      exclude_keywords: ['k'.repeat(RULE_KEYWORD_MAX_LENGTH + 1)],
    });

    expect(constraintKeys(dto)).toContain('rule_keyword_too_long');
  });

  it.each([
    ['CreateRuleDto', CreateRuleDto],
    ['UpdateRuleDto', UpdateRuleDto],
  ])('%s trims the name so whitespace cannot fork one rule into two', (_label, dtoClass) => {
    const dto = plainToInstance(dtoClass, { name: '  AI updates  ', include_keywords: ['ai'] }) as CreateRuleDto;

    expect(validateSync(dto, { whitelist: true })).toEqual([]);
    expect(dto.name).toBe('AI updates');
  });

  it('still enforces the pre-existing array-size cap', () => {
    const dto = plainToInstance(CreateRuleDto, {
      name: 'Too many',
      include_keywords: Array.from({ length: 21 }, (_value, index) => `k${index}`),
    });

    expect(constraintKeys(dto)).toContain('arrayMaxSize');
  });
});

describe('ListEntriesQueryDto.search bounds', () => {
  it('accepts a search term of exactly 200 characters', () => {
    const dto = plainToInstance(ListEntriesQueryDto, { search: 's'.repeat(ENTRY_SEARCH_MAX_LENGTH) });

    expect(validateSync(dto, { whitelist: true })).toEqual([]);
  });

  it('rejects a search term over 200 characters', () => {
    const dto = plainToInstance(ListEntriesQueryDto, { search: 's'.repeat(ENTRY_SEARCH_MAX_LENGTH + 1) });

    expect(constraintKeys(dto)).toContain('entry_search_too_long');
  });

  it('leaves the query valid when search is omitted', () => {
    expect(validateSync(plainToInstance(ListEntriesQueryDto, {}), { whitelist: true })).toEqual([]);
  });
});
