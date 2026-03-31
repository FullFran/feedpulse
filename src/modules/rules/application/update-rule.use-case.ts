import { Injectable, NotFoundException } from '@nestjs/common';

import { RulesRepository } from '../rules.repository';

@Injectable()
export class UpdateRuleUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  async execute(input: {
    tenantId: string;
    id: number;
    name?: string;
    includeKeywords?: string[];
    excludeKeywords?: string[];
    isActive?: boolean;
  }) {
    const rule = await this.rulesRepository.update(input);

    if (!rule) {
      throw new NotFoundException('rule_not_found');
    }

    return rule;
  }
}
