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

  async create(input: { tenantId: string; name: string; includeKeywords: string[]; excludeKeywords: string[]; isActive: boolean }): Promise<Rule> {
    const result = await this.databaseService.query<RuleRow>(
      `
        INSERT INTO rules (tenant_id, name, include_keywords, exclude_keywords, is_active)
        VALUES ($1, $2, $3::text[], $4::text[], $5)
        RETURNING *
      `,
      [input.tenantId, input.name, input.includeKeywords, input.excludeKeywords, input.isActive],
    );

    return mapRule(result.rows[0]);
  }

  async list(input: { tenantId: string; page: number; pageSize: number; isActive?: boolean; query?: string }): Promise<{ items: Rule[]; total: number }> {
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

  async listActive(tenantId?: string): Promise<Rule[]> {
    const result = tenantId
      ? await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE tenant_id = $1 AND is_active = true ORDER BY id ASC', [tenantId])
      : await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE is_active = true ORDER BY id ASC');
    return result.rows.map(mapRule);
  }

  async findByName(name: string, tenantId: string): Promise<Rule | null> {
    const result = await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE tenant_id = $1 AND name = $2 LIMIT 1', [tenantId, name]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async upsertByName(input: { tenantId: string; name: string; includeKeywords: string[]; excludeKeywords: string[]; isActive: boolean }): Promise<Rule> {
    const existing = await this.findByName(input.name, input.tenantId);
    if (!existing) {
      return this.create(input);
    }

    const updated = await this.update({
      id: existing.id,
      tenantId: input.tenantId,
      includeKeywords: input.includeKeywords,
      excludeKeywords: input.excludeKeywords,
      isActive: input.isActive,
    });

    if (!updated) {
      throw new Error('rule_upsert_failed');
    }

    return updated;
  }

  async findById(id: number, tenantId?: string): Promise<Rule | null> {
    const result = tenantId
      ? await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE tenant_id = $1 AND id = $2', [tenantId, id])
      : await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE id = $1', [id]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async update(input: {
    tenantId?: string;
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
          AND ($6::text IS NULL OR tenant_id = $6)
        RETURNING *
      `,
      [
        input.id,
        input.name ?? current.name,
        input.includeKeywords ?? current.includeKeywords,
        input.excludeKeywords ?? current.excludeKeywords,
        input.isActive ?? current.isActive,
        input.tenantId ?? null,
      ],
    );

    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async disable(id: number, tenantId?: string): Promise<boolean> {
    const updated = await this.update({ id, isActive: false, tenantId });
    return Boolean(updated);
  }
}
