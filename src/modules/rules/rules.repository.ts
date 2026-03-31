import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../infrastructure/persistence/database.service';

import { Rule } from './domain/rule.entity';

interface RuleRow {
  id: number;
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

  async create(input: { name: string; includeKeywords: string[]; excludeKeywords: string[]; isActive: boolean }): Promise<Rule> {
    const result = await this.databaseService.query<RuleRow>(
      `
        INSERT INTO rules (name, include_keywords, exclude_keywords, is_active)
        VALUES ($1, $2::text[], $3::text[], $4)
        RETURNING *
      `,
      [input.name, input.includeKeywords, input.excludeKeywords, input.isActive],
    );

    return mapRule(result.rows[0]);
  }

  async list(input: { page: number; pageSize: number; isActive?: boolean; query?: string }): Promise<{ items: Rule[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];

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

  async listActive(): Promise<Rule[]> {
    const result = await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE is_active = true ORDER BY id ASC');
    return result.rows.map(mapRule);
  }

  async findByName(name: string): Promise<Rule | null> {
    const result = await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE name = $1 LIMIT 1', [name]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async upsertByName(input: { name: string; includeKeywords: string[]; excludeKeywords: string[]; isActive: boolean }): Promise<Rule> {
    const existing = await this.findByName(input.name);
    if (!existing) {
      return this.create(input);
    }

    const updated = await this.update({
      id: existing.id,
      includeKeywords: input.includeKeywords,
      excludeKeywords: input.excludeKeywords,
      isActive: input.isActive,
    });

    if (!updated) {
      throw new Error('rule_upsert_failed');
    }

    return updated;
  }

  async findById(id: number): Promise<Rule | null> {
    const result = await this.databaseService.query<RuleRow>('SELECT * FROM rules WHERE id = $1', [id]);
    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async update(input: {
    id: number;
    name?: string;
    includeKeywords?: string[];
    excludeKeywords?: string[];
    isActive?: boolean;
  }): Promise<Rule | null> {
    const current = await this.findById(input.id);

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
        RETURNING *
      `,
      [
        input.id,
        input.name ?? current.name,
        input.includeKeywords ?? current.includeKeywords,
        input.excludeKeywords ?? current.excludeKeywords,
        input.isActive ?? current.isActive,
      ],
    );

    return result.rows[0] ? mapRule(result.rows[0]) : null;
  }

  async disable(id: number): Promise<boolean> {
    const updated = await this.update({ id, isActive: false });
    return Boolean(updated);
  }
}
