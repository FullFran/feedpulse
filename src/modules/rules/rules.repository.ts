import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { Rule } from './domain/rule.entity';

interface RuleRow {
  id: number;
  tenant_id: string;
  name: string;
  include_keywords: string[];
  exclude_keywords: string[];
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** One rule as it arrives from a batch create request, already mapped out of HTTP shapes. */
export interface RuleDraft {
  name: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  isActive: boolean;
}

/**
 * Outcome of a create-only batch insert.
 *
 * The three lists are disjoint by construction, so a caller can render them
 * without having to reconcile them: a name is either created, or skipped because
 * the tenant already had a rule with that name, or collapsed because the request
 * itself listed it more than once.
 */
export interface BatchInsertRulesResult {
  created: Rule[];
  /** Names left untouched because a rule with that name already existed. */
  skippedNames: string[];
  /** Names the request listed more than once; only the first occurrence was used. */
  duplicateNames: string[];
}

function mapRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    includeKeywords: row.include_keywords,
    excludeKeywords: row.exclude_keywords,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class RulesRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async create(input: {
    tenantId: string;
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
    isActive: boolean;
  }): Promise<Rule> {
    const result = await this.databaseService.query<RuleRow>(
      `
        INSERT INTO rules (tenant_id, name, include_keywords, exclude_keywords, is_active)
        VALUES ($1, $2, $3::text[], $4::text[], $5)
        RETURNING *
      `,
      [input.tenantId, input.name, input.includeKeywords, input.excludeKeywords, input.isActive],
    );

    const row = result.rows[0];

    if (!row) {
      // `INSERT ... RETURNING *` always yields exactly one row. The guard is
      // here so the impossible case fails loudly instead of dereferencing
      // `undefined` somewhere downstream inside `mapRule`.
      throw new Error('rule_insert_returned_no_row');
    }

    return mapRule(row);
  }

  async list(input: {
    tenantId: string;
    page: number;
    pageSize: number;
    isActive?: boolean;
    query?: string;
  }): Promise<{ items: Rule[]; total: number }> {
    const where: string[] = [`tenant_id = $1`];
    const values: unknown[] = [input.tenantId];

    if (typeof input.isActive === 'boolean') {
      where.push(`is_active = $${values.length + 1}`);
      values.push(input.isActive);
    }

    if (input.query) {
      where.push(`name ILIKE $${values.length + 1}`);
      values.push(`%${input.query}%`);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (input.page - 1) * input.pageSize;

    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<RuleRow>(
        `SELECT * FROM rules ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, input.pageSize, offset],
      ),
      this.databaseService.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rules ${clause}`, values),
    ]);

    return {
      items: itemsResult.rows.map(mapRule),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  /**
   * Active rules for one tenant. `tenantId` is REQUIRED.
   *
   * This used to fall back to "every active rule in the installation" when the argument was
   * omitted, which would have evaluated tenant A's articles against tenant B's rules — the
   * ingestion pipeline is the single caller and it always knows the feed's tenant. No
   * `listActiveForWorker` counterpart exists on purpose: matching is never cross-tenant.
   */
  async listActive(tenantId: string): Promise<Rule[]> {
    const result = await this.databaseService.query<RuleRow>(
      'SELECT * FROM rules WHERE tenant_id = $1 AND is_active = true ORDER BY id ASC',
      [tenantId],
    );
    return result.rows.map(mapRule);
  }

  /**
   * Reads one rule by its tenant-scoped name.
   *
   * DELIBERATELY RETAINED WITH NO PRODUCTION CALLER. `upsertByName` used to call
   * this as the read half of a read-then-write; it is now a single
   * `INSERT ... ON CONFLICT`, so nothing in `src/` calls this any more.
   *
   * It stays because it is the verification read the integration specs use to
   * assert what `upsertByName` actually wrote — see
   * `test/rules-batch.integration-spec.ts` and
   * `test/tenant-isolation.integration-spec.ts`, where it also proves a rule
   * name is scoped per tenant. Deleting it as "dead code" breaks those specs.
   */
  async findByName(name: string, tenantId: string): Promise<Rule | null> {
    const result = await this.databaseService.query<RuleRow>(
      'SELECT * FROM rules WHERE tenant_id = $1 AND name = $2 LIMIT 1',
      [tenantId, name],
    );
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  /**
   * Create-or-replace keyed on `(tenant_id, name)`, in one statement.
   *
   * This used to be a read-then-write: `findByName`, then either `create` or `update`. With no
   * uniqueness rule behind it, two OPML imports running at the same time could both observe
   * "no existing rule" and both take the create branch, leaving a tenant with two rules of the
   * same name. Migration 0020 adds `idx_rules_tenant_name_unique` and this method now leans on
   * it: the conflict is resolved by PostgreSQL inside a single statement, so there is no window
   * between the read and the write for a concurrent writer to slip into.
   *
   * `name` is deliberately absent from the SET list — it is the conflict key, so writing it back
   * would be a no-op — and `created_at` is preserved, so an upserted rule keeps its age.
   */
  async upsertByName(input: {
    tenantId: string;
    name: string;
    includeKeywords: string[];
    excludeKeywords: string[];
    isActive: boolean;
  }): Promise<Rule> {
    const result = await this.databaseService.query<RuleRow>(
      `
        INSERT INTO rules (tenant_id, name, include_keywords, exclude_keywords, is_active)
        VALUES ($1, $2, $3::text[], $4::text[], $5)
        ON CONFLICT (tenant_id, name) DO UPDATE
        SET include_keywords = EXCLUDED.include_keywords,
            exclude_keywords = EXCLUDED.exclude_keywords,
            is_active = EXCLUDED.is_active,
            updated_at = NOW()
        RETURNING *
      `,
      [input.tenantId, input.name, input.includeKeywords, input.excludeKeywords, input.isActive],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error('rule_upsert_failed');
    }

    return mapRule(row);
  }

  /**
   * Create-only batch insert backing `POST /api/v1/rules/batch`.
   *
   * CREATE-ONLY is the contract, not an implementation detail: a batch import must never
   * silently rewrite a rule the caller forgot they already had, so an existing name is reported
   * back rather than overwritten. Callers who do want replacement have `upsertByName`.
   *
   * Everything happens in ONE statement, which makes it atomic without an explicit transaction
   * or a checked-out client:
   *
   *  - the `LEFT JOIN ... WHERE existing.id IS NULL` filter is what makes the result reportable.
   *    `ON CONFLICT DO NOTHING RETURNING *` alone cannot distinguish "inserted" from "skipped"
   *    portably — real PostgreSQL returns only the inserted rows, while the pg-mem emulator the
   *    unit suites run on also returns the conflicting row. Filtering the pre-existing names out
   *    before the insert makes `RETURNING` mean the same thing on both engines.
   *  - `ON CONFLICT (tenant_id, name) DO NOTHING` is still required. The `LEFT JOIN` is a
   *    snapshot taken inside the same statement, so it closes the reporting gap, not the race
   *    with a concurrent writer; the unique index from migration 0020 does that.
   *
   * Duplicate names WITHIN one request are collapsed before the SQL runs (first occurrence
   * wins). Without that, the single multi-row INSERT would try to insert the same
   * `(tenant_id, name)` twice in one command, which `ON CONFLICT` does not cover: PostgreSQL
   * raises `ON CONFLICT DO UPDATE command cannot affect row a second time` for the DO UPDATE
   * form and, more importantly, the caller would never learn their payload was self-conflicting.
   */
  async insertIgnoreOnConflict(drafts: RuleDraft[], tenantId: string): Promise<BatchInsertRulesResult> {
    const uniqueDrafts: RuleDraft[] = [];
    const seenNames = new Set<string>();
    const duplicateNames: string[] = [];

    for (const draft of drafts) {
      if (seenNames.has(draft.name)) {
        if (!duplicateNames.includes(draft.name)) {
          duplicateNames.push(draft.name);
        }
        continue;
      }

      seenNames.add(draft.name);
      uniqueDrafts.push(draft);
    }

    if (uniqueDrafts.length === 0) {
      return { created: [], skippedNames: [], duplicateNames };
    }

    const values: unknown[] = [tenantId];
    const tuples = uniqueDrafts.map((draft) => {
      const base = values.length;
      values.push(draft.name, draft.includeKeywords, draft.excludeKeywords, draft.isActive);
      return `($${base + 1}::text, $${base + 2}::text[], $${base + 3}::text[], $${base + 4}::boolean)`;
    });

    const result = await this.databaseService.query<RuleRow>(
      `
        INSERT INTO rules (tenant_id, name, include_keywords, exclude_keywords, is_active)
        SELECT $1, candidate.name, candidate.include_keywords, candidate.exclude_keywords, candidate.is_active
        FROM (VALUES ${tuples.join(', ')}) AS candidate (name, include_keywords, exclude_keywords, is_active)
        LEFT JOIN rules existing
          ON existing.tenant_id = $1
         AND existing.name = candidate.name
        WHERE existing.id IS NULL
        ON CONFLICT (tenant_id, name) DO NOTHING
        RETURNING *
      `,
      values,
    );

    const created = result.rows.map(mapRule);
    const createdNames = new Set(created.map((rule) => rule.name));

    return {
      created,
      skippedNames: uniqueDrafts.map((draft) => draft.name).filter((name) => !createdNames.has(name)),
      duplicateNames,
    };
  }

  /**
   * Tenant-scoped lookup. `tenantId` is REQUIRED: rule ids are sequential and an omitted
   * tenant used to widen the query to every rule in the installation.
   */
  async findById(id: number, tenantId: string): Promise<Rule | null> {
    const result = await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE tenant_id = $1 AND id = $2', [
      tenantId,
      id,
    ]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  /** Tenant-scoped update. `tenantId` is REQUIRED; there is no cross-tenant update path. */
  async update(input: {
    tenantId: string;
    id: number;
    name?: string;
    includeKeywords?: string[];
    excludeKeywords?: string[];
    isActive?: boolean;
  }): Promise<Rule | null> {
    const current = await this.findById(input.id, input.tenantId);

    if (!current) {
      return null;
    }

    const result = await this.databaseService.query<RuleRow>(
      `
        UPDATE rules
        SET name = $2,
            include_keywords = $3::text[],
            exclude_keywords = $4::text[],
            is_active = $5,
            updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $6
        RETURNING *
      `,
      [
        input.id,
        input.name ?? current.name,
        input.includeKeywords ?? current.includeKeywords,
        input.excludeKeywords ?? current.excludeKeywords,
        input.isActive ?? current.isActive,
        input.tenantId,
      ],
    );

    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  /** Tenant-scoped disable. `tenantId` is REQUIRED; there is no cross-tenant disable path. */
  async disable(id: number, tenantId: string): Promise<boolean> {
    const updated = await this.update({ id, isActive: false, tenantId });
    return Boolean(updated);
  }
}
