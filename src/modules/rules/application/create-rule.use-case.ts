import { Injectable } from '@nestjs/common';

import { Rule } from '../domain/rule.entity';
import { RulesRepository } from '../rules.repository';

@Injectable()
export class CreateRuleUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  execute(input: { tenantId: string; name: string; includeKeywords: string[]; excludeKeywords?: string[]; isActive?: boolean }): Promise<Rule> {
    return this.rulesRepository.create({
      tenantId: input.tenantId,
      name: input.name,
      includeKeywords: input.includeKeywords,
      excludeKeywords: input.excludeKeywords ?? [],
      isActive: input.isActive ?? true,
    });
  }
}
